-- 残業申請のカレンダー：残業がなかった日の「定時」の記録（2026-10-12 ユーザー確定）
--
-- 【何をするか】
--  ・本人が事後で「シフト通り勤務した（残業なし）」を任意で記録する（overtime_day_checks）。
--    🚨 残業申請（overtime_reports）には入れない。受理・合計時間・Googleカレンダー・通知・
--       「本人×日付で手動の申請は1件まで」（uq_overtime_manual_per_day）に一切触れないため（案X）。
--  ・試す人は「役職ごと・個人ごと」で決める（overtime_day_check_rules。個人が役職より優先）。
--    最初は三役の3人を個人で、あとで役職「マネージャー」に広げる（ユーザー確定）。
--  ・書き込み・取り消しは関数（overtime_day_check_record / _cancel）だけ。表に直接は書かせない。
--  ・その日に残業申請・打刻ズレ（取消以外の manual 行）が入ったら、定時の記録は自動で消す（トリガー）。
--    🚨 中心の申請の処理（saveOvertimeReport・overtime-approve）には手を入れない。
--  ・給与の締め（支給月17日）を過ぎた日は、記録も取り消しもできない（許可の窓でも開けない）。
--  ・記録は10年残す（会社法の会計帳簿10年に合わせる）。月1回の cron で10年を過ぎたものを消す。
--
-- 🚨 日付は必ず (now() at time zone 'Asia/Tokyo')::date。current_date は UTC なので 0〜9時に1日ずれる。

begin;

-- ========================================
-- 1) 試す人の設定（役職ごと・個人ごと）
-- ========================================
create table if not exists public.overtime_day_check_rules (
  id         uuid primary key default gen_random_uuid(),
  role_id    uuid references public.roles(id) on delete cascade,
  user_id    uuid references public.profiles(id) on delete cascade,
  enabled    boolean not null default true,
  created_at timestamptz not null default now(),
  constraint overtime_day_check_rules_scope_check
    check ((role_id is not null and user_id is null) or (role_id is null and user_id is not null)),
  constraint overtime_day_check_rules_role_id_key unique (role_id),
  constraint overtime_day_check_rules_user_id_key unique (user_id)
);
comment on table public.overtime_day_check_rules is
  '残業申請のカレンダーの印・定時の記録を使える人（役職ごと・個人ごと。個人が役職より優先）。2026-10-12';

alter table public.overtime_day_check_rules enable row level security;

-- 読み書きとも管理者だけ（本人は overtime_day_check_enabled() で聞く）
drop policy if exists odcr_admin_all on public.overtime_day_check_rules;
create policy odcr_admin_all on public.overtime_day_check_rules
  for all to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- 自分が使えるか（個人 > 役職 > 使えない）。役職は role_id で照合（改名しても対象がずれない）
create or replace function public.overtime_day_check_enabled()
returns boolean
language sql stable security definer set search_path to 'public'
as $$
  select coalesce(
    (select r.enabled from overtime_day_check_rules r where r.user_id = auth.uid()),
    (select r.enabled from overtime_day_check_rules r
       join profiles p on p.role_id = r.role_id
      where p.id = auth.uid() and r.role_id is not null),
    false
  );
$$;
revoke execute on function public.overtime_day_check_enabled() from public;
revoke execute on function public.overtime_day_check_enabled() from anon;
grant execute on function public.overtime_day_check_enabled() to authenticated;

-- ========================================
-- 2) 定時の記録
-- ========================================
create table if not exists public.overtime_day_checks (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.profiles(id) on delete cascade,
  work_date      date not null,
  -- 記録した時点の通常シフト（残業申請の normal_shift と同じ形）。あとで勤務パターンが変わっても、何を見て記録したかが残る
  shift_snapshot jsonb not null,
  created_at     timestamptz not null default now(),
  constraint overtime_day_checks_user_date_key unique (user_id, work_date)
);
comment on table public.overtime_day_checks is
  '残業がなかった日の「定時」の記録（本人が任意で記録・受理なし・合計時間に影響しない）。10年で消す。2026-10-12';

create index if not exists idx_overtime_day_checks_date on public.overtime_day_checks (work_date);

alter table public.overtime_day_checks enable row level security;

-- 読む：本人／管理者／部門集計を見られる人（残業申請の overtime_select_summary と同じ条件）
drop policy if exists odc_select_own on public.overtime_day_checks;
create policy odc_select_own on public.overtime_day_checks
  for select to authenticated using (user_id = auth.uid());

drop policy if exists odc_select_admin on public.overtime_day_checks;
create policy odc_select_admin on public.overtime_day_checks
  for select to authenticated using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

drop policy if exists odc_select_summary on public.overtime_day_checks;
create policy odc_select_summary on public.overtime_day_checks
  for select to authenticated using (
    has_feature_permission('overtime_summary')
    and overtime_role_rank_target(user_id) >= (select overtime_role_rank(auth.uid()))
  );
-- 🚨 insert / update / delete の許可は作らない（書くのは下の関数だけ）

-- 締め切り（支給月17日）を過ぎたか。残業申請の締めロック（overtime_grant_requests の trigger）と同じ計算
create or replace function public.overtime_day_check_closed(p_date date)
returns boolean
language plpgsql stable set search_path to 'public'
as $$
declare
  v_pps    date;
  v_cutoff date;
begin
  if extract(day from p_date) >= 16 then
    v_pps := date_trunc('month', p_date)::date + 15;
  else
    v_pps := (date_trunc('month', p_date) - interval '1 month')::date + 15;
  end if;
  v_cutoff := (date_trunc('month', v_pps + interval '1 month'))::date + 16;
  return (now() at time zone 'Asia/Tokyo')::date > v_cutoff;
end;
$$;
revoke execute on function public.overtime_day_check_closed(date) from public;
revoke execute on function public.overtime_day_check_closed(date) from anon;
revoke execute on function public.overtime_day_check_closed(date) from authenticated;

-- 記録する。返り値は記録の id（すでにあればその id）
create or replace function public.overtime_day_check_record(p_date date, p_shift jsonb)
returns uuid
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_uid   uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_d     text := to_char(p_date, 'YYYY-MM-DD');
  v_id    uuid;
begin
  if v_uid is null then
    raise exception 'DAY_CHECK_AUTH: ログインしてください' using errcode = 'insufficient_privilege';
  end if;
  if not overtime_day_check_enabled() then
    raise exception 'DAY_CHECK_DISABLED: この機能はまだ使えません' using errcode = 'insufficient_privilege';
  end if;
  if p_date is null or p_date > v_today then
    raise exception 'DAY_CHECK_FUTURE: 先の日は記録できません' using errcode = 'check_violation';
  end if;
  if overtime_day_check_closed(p_date) then
    raise exception 'DAY_CHECK_CLOSED: この日の給与期間は締め切りを過ぎています' using errcode = 'check_violation';
  end if;
  if p_shift is null or coalesce(p_shift ->> 'start_time', '') = '' then
    raise exception 'DAY_CHECK_NO_SHIFT: この日はシフトがありません' using errcode = 'check_violation';
  end if;
  if exists (select 1 from overtime_reports r
              where r.applicant_id = v_uid and r.entry_type = 'manual' and r.status <> 'cancelled'
                and (r.work_date = p_date or r.furikae_origin_date = p_date)) then
    raise exception 'DAY_CHECK_HAS_REPORT: この日はすでに申請があります' using errcode = 'check_violation';
  end if;
  if exists (select 1 from leave_requests l
              where l.user_id = v_uid and coalesce(l.status, '') not in ('rejected', 'cancelled')
                and (case when l.leave_dates like '[%' then (l.leave_dates::jsonb ? v_d)
                          else p_date between l.start_date and l.end_date end)) then
    raise exception 'DAY_CHECK_HAS_LEAVE: この日は休暇の申請があります' using errcode = 'check_violation';
  end if;
  if exists (select 1 from attendance_exceptions e where e.user_id = v_uid and e.date = p_date) then
    raise exception 'DAY_CHECK_HAS_EXCEPTION: この日は勤怠カレンダーで予定が変わっています' using errcode = 'check_violation';
  end if;
  if exists (select 1 from application_requests a
              where a.recipient_id = v_uid and a.status = 'open' and p_date = any(a.target_dates)) then
    raise exception 'DAY_CHECK_HAS_REQUEST: この日は申請の依頼が届いています' using errcode = 'check_violation';
  end if;

  insert into overtime_day_checks (user_id, work_date, shift_snapshot)
  values (v_uid, p_date, p_shift)
  on conflict on constraint overtime_day_checks_user_date_key do nothing
  returning id into v_id;
  if v_id is null then
    select id into v_id from overtime_day_checks where user_id = v_uid and work_date = p_date;
  end if;
  return v_id;
end;
$$;
revoke execute on function public.overtime_day_check_record(date, jsonb) from public;
revoke execute on function public.overtime_day_check_record(date, jsonb) from anon;
grant execute on function public.overtime_day_check_record(date, jsonb) to authenticated;

-- 取り消す。返り値は消した件数（0＝もう無かった）
create or replace function public.overtime_day_check_cancel(p_date date)
returns integer
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_n   integer;
begin
  if v_uid is null then
    raise exception 'DAY_CHECK_AUTH: ログインしてください' using errcode = 'insufficient_privilege';
  end if;
  if overtime_day_check_closed(p_date) then
    raise exception 'DAY_CHECK_CLOSED: この日の給与期間は締め切りを過ぎています' using errcode = 'check_violation';
  end if;
  delete from overtime_day_checks where user_id = v_uid and work_date = p_date;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;
revoke execute on function public.overtime_day_check_cancel(date) from public;
revoke execute on function public.overtime_day_check_cancel(date) from anon;
grant execute on function public.overtime_day_check_cancel(date) to authenticated;

-- ========================================
-- 3) その日に残業申請・打刻ズレが入ったら、定時の記録を消す
--    打刻ズレの入口は3つ（本人の画面・経理への回答・表入力）。画面ごとに書くと漏れるのでここで1回
-- ========================================
create or replace function public.overtime_day_checks_clear_on_report()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
begin
  if new.entry_type = 'manual' and new.status <> 'cancelled' then
    delete from overtime_day_checks
     where user_id = new.applicant_id
       and (work_date = new.work_date or work_date = new.furikae_origin_date);
  end if;
  return null;
end;
$$;
revoke execute on function public.overtime_day_checks_clear_on_report() from public;
revoke execute on function public.overtime_day_checks_clear_on_report() from anon;
revoke execute on function public.overtime_day_checks_clear_on_report() from authenticated;

drop trigger if exists trg_overtime_day_checks_clear on public.overtime_reports;
create trigger trg_overtime_day_checks_clear
  after insert or update of status, work_date, furikae_origin_date on public.overtime_reports
  for each row execute function public.overtime_day_checks_clear_on_report();

-- ========================================
-- 4) 10年を過ぎた記録を消す（月1回・UTC 1日 19:10＝JST 2日 4:10）
-- ========================================
create or replace function public.purge_overtime_day_checks()
returns void
language sql security definer set search_path to 'public'
as $$
  delete from overtime_day_checks
   where work_date < ((now() at time zone 'Asia/Tokyo')::date - interval '10 years');
$$;
revoke execute on function public.purge_overtime_day_checks() from public;
revoke execute on function public.purge_overtime_day_checks() from anon;
revoke execute on function public.purge_overtime_day_checks() from authenticated;

select cron.unschedule(jobid) from cron.job where jobname = 'purge-overtime-day-checks-monthly';
select cron.schedule('purge-overtime-day-checks-monthly', '10 19 1 * *', $cron$select public.purge_overtime_day_checks();$cron$);

commit;
