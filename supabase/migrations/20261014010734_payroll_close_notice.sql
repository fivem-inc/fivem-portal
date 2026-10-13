-- 給与の締め日のお知らせ（毎月14日 10:00・2026-10-14 ユーザー確定・計画は docs/計画-締め日のお知らせ.md）
-- ・14日が会社休（company_calendar.kind='closed_all'）なら、その前の会社休でない日の 10:00。土日は休館日扱いしない
-- ・ベル＋スマホ＋ホームのバナー。行ごとに届く相手を決める（権限管理の ON と公開設定・雇用形態・受理まちの有無）
-- ・文面と ON/OFF は管理画面「通知設定」の「締め日のお知らせ」（app_settings key='payroll_close_notice'）
-- 🚨 文面を組み立てる判定は payroll_close_compose → payroll_close_lines の1本だけ。
--    送信（cron）・バナー・プレビュー・試し送信のすべてがこれを呼ぶ（同じ判定を2か所に書かない）
-- 🚨 最初は enabled=false・start_close_date=2026-11-15。10月分は経理がメールで送り済みなので、
--    「取りこぼしたら翌日に送る」作りが 10/15 に10月分を送らないようにする
begin;

-- ───────────────────────────────────────────────
-- 1. 設定（読み＝ログイン者・書き＝管理者：app_settings の既存ポリシー）
-- ───────────────────────────────────────────────
insert into public.app_settings (key, value) values ('payroll_close_notice', jsonb_build_object(
  'enabled', false,
  'start_close_date', '2026-11-15',
  'bell', true, 'push', true, 'banner', true,
  'lines', jsonb_build_object(
    'intro',      '{締め日}は給与の締め日です',
    'overtime',   '残業申請の出し忘れや、実績報告がまだの日がないか、確認をお願いします。',
    'ot_pending', '受理がまだの残業申請が{件数}件あります。15日までに受理をお願いします。',
    'shift',      'シフトと違う勤務をした方は、勤務変更の報告もお願いします。',
    'sr_pending', '確認がまだの勤務変更が{件数}件あります。15日までに確認をお願いします。',
    'expense',    '交通費の申請がまだの方は、15日までに申請をお願いします。',
    -- 🚨 交通費の画面の注意事項（ExpenseForm）と同じ文。決まりが変わったら両方を直す
    'commuter',   '定期券は、原則6か月定期で購入してください（入社6か月未満の方は3か月定期）。',
    'outro',      'ご不明な方は、経理担当までご相談ください。'
  )))
on conflict (key) do nothing;

-- スマホ通知の ON/OFF（push-dispatch が event_key の先頭2つ＝payroll:close_notice で引く）
insert into public.notification_settings (event_key, channel, enabled)
values ('payroll:close_notice', 'push', true)
on conflict (event_key, channel) do nothing;

-- ───────────────────────────────────────────────
-- 2. 送った記録（掃除：2年より古いものを毎月消す）
-- ───────────────────────────────────────────────
create table if not exists public.payroll_close_notices (
  close_date      date primary key,
  sent_at         timestamptz not null default now(),
  recipient_count int not null default 0
);
-- 🚨 notification_id に外部キーを付けない（既読30日でベルの行は消えるため）
create table if not exists public.payroll_close_notice_recipients (
  close_date      date not null references public.payroll_close_notices(close_date) on delete cascade,
  user_id         uuid not null references auth.users(id) on delete cascade,
  notification_id uuid,
  dismissed_at    timestamptz,
  created_at      timestamptz not null default now(),
  primary key (close_date, user_id)
);
alter table public.payroll_close_notices enable row level security;
alter table public.payroll_close_notice_recipients enable row level security;
-- 画面からは直接読まない・書かない（読み書きは下の関数だけ）。ポリシーを作らない＝誰も触れない
revoke all on public.payroll_close_notices from anon, authenticated;
revoke all on public.payroll_close_notice_recipients from anon, authenticated;

-- ───────────────────────────────────────────────
-- 3. 日付の計算
-- ───────────────────────────────────────────────
-- その日から見た「次の締め日」（15日まではその月の15日、16日からは翌月の15日）
create or replace function public.payroll_close_date_for(p_today date)
returns date language sql immutable as $$
  select case when extract(day from p_today) <= 15
              then make_date(extract(year from p_today)::int, extract(month from p_today)::int, 15)
              else (date_trunc('month', p_today) + interval '1 month')::date + 14 end;
$$;

-- 送る日：締め日の前日から、会社休をさかのぼる（土日は休館日扱いしない・上限31日）
create or replace function public.payroll_close_send_date(p_close date)
returns date language plpgsql stable security definer set search_path = public as $$
declare v_d date := p_close - 1; i int := 0;
begin
  while i < 31 and exists (select 1 from public.company_calendar c where c.date = v_d and c.kind = 'closed_all') loop
    v_d := v_d - 1; i := i + 1;
  end loop;
  return v_d;
end $$;

-- 「11月15日（日）」
create or replace function public.payroll_close_jp_date(p_d date)
returns text language sql immutable as $$
  select extract(month from p_d)::int || '月' || extract(day from p_d)::int || '日（'
         || (array['日','月','火','水','木','金','土'])[extract(dow from p_d)::int + 1] || '）';
$$;

-- ───────────────────────────────────────────────
-- 4. 文面を組み立てる（行の出し分けを受けて、設定の文を並べる）
--    p_lines_override：管理画面のプレビューで、保存前の文を試すときだけ渡す
--    空の文の行は出さない（はじめの行だけは空なら初期の文）。本文の行が1つも無ければ空の配列
-- ───────────────────────────────────────────────
create or replace function public.payroll_close_lines(
  p_close date, p_ot boolean, p_shift boolean, p_expense boolean, p_commuter boolean,
  p_ot_pending int, p_sr_pending int, p_lines_override jsonb default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_lines jsonb;
  v_out   jsonb := '[]'::jsonb;
  v_body  int := 0;
  v_date  text := public.payroll_close_jp_date(p_close);
  k text; v_on boolean; v_cnt int; v_t text;
begin
  select s.value -> 'lines' into v_lines from public.app_settings s where s.key = 'payroll_close_notice';
  v_lines := coalesce(v_lines, '{}'::jsonb) || coalesce(p_lines_override, '{}'::jsonb);
  foreach k in array array['intro','overtime','ot_pending','shift','sr_pending','expense','commuter','outro'] loop
    v_cnt := null;
    v_on := case k
      when 'intro' then true when 'outro' then true
      when 'overtime' then p_ot
      when 'ot_pending' then coalesce(p_ot_pending, 0) > 0
      when 'shift' then p_shift
      when 'sr_pending' then coalesce(p_sr_pending, 0) > 0
      when 'expense' then p_expense
      when 'commuter' then p_commuter end;
    if not coalesce(v_on, false) then continue; end if;
    if k = 'ot_pending' then v_cnt := p_ot_pending; elsif k = 'sr_pending' then v_cnt := p_sr_pending; end if;
    v_t := btrim(coalesce(v_lines ->> k, ''));
    if v_t = '' and k = 'intro' then v_t := '{締め日}は給与の締め日です'; end if;
    if v_t = '' then continue; end if;
    v_t := replace(replace(v_t, '{締め日}', v_date), '{件数}', coalesce(v_cnt, 0)::text);
    v_out := v_out || jsonb_build_array(jsonb_build_object('key', k, 'text', v_t, 'count', v_cnt));
    if k not in ('intro', 'outro') then v_body := v_body + 1; end if;
  end loop;
  if v_body = 0 then return '[]'::jsonb; end if;
  return v_out;
end $$;

-- 機能が「使える」か：役職の権限（feature_permissions）と公開設定（feature_published*）の両方。
-- 画面の isFeaturePublished（hooks/useFeaturePublished.ts）と同じ考え方。管理者は呼ぶ前に外している
create or replace function public.payroll_close_feature_on(p_user uuid, p_key text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare v_role record; v_pub jsonb; v_lead jsonb; v_pres jsonb;
begin
  select r.* into v_role from public.profiles p join public.roles r on r.id = p.role_id where p.id = p_user;
  if not found then return false; end if;
  if not exists (select 1 from public.feature_permissions fp
                  where fp.role_id = v_role.id and fp.feature_key = p_key and fp.enabled) then
    return false;
  end if;
  select value into v_pub  from public.app_settings where key = 'feature_published';
  select value into v_lead from public.app_settings where key = 'feature_published_leader';
  select value into v_pres from public.app_settings where key = 'feature_published_president';
  return coalesce(v_pub -> p_key, 'true'::jsonb) <> 'false'::jsonb
      or (coalesce(v_lead ->> p_key, '') = 'true' and coalesce(v_role.is_leader_plus, false))
      or (coalesce(v_pres ->> p_key, '') = 'true' and coalesce(v_role.is_org_wide, false));
end $$;

-- その人に届く行（件数はその時点）。届かない人は空の配列
create or replace function public.payroll_close_compose(p_user uuid, p_close date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_p record; v_retiree boolean := false; v_keys jsonb := null; v_part boolean;
  v_ot boolean; v_sh boolean; v_ex boolean; v_otp int := 0; v_srp int := 0;
begin
  select pr.id, pr.is_active, pr.employment_type into v_p from public.profiles pr where pr.id = p_user;
  if not found then return '[]'::jsonb; end if;
  -- 「管理者」の共用アカウントには送らない（2026-10-14 ユーザー確定）
  if exists (select 1 from auth.users u where u.id = p_user and (u.raw_app_meta_data ->> 'role') = 'admin') then
    return '[]'::jsonb;
  end if;
  if not coalesce(v_p.is_active, false) then
    -- 退職して申請できる期間中の人には送る（2026-10-14 ユーザー確定）。入社予定・それ以外の在籍していない人には送らない
    if not public.is_retiree_in_grace(p_user) then return '[]'::jsonb; end if;
    v_retiree := true;
    select coalesce(s.value -> 'keys', '[]'::jsonb) into v_keys from public.app_settings s where s.key = 'retiree_feature_keys';
    v_keys := coalesce(v_keys, '[]'::jsonb);
  end if;
  v_part := coalesce(v_p.employment_type, '正社員') = 'パート';
  v_ot := public.payroll_close_feature_on(p_user, 'overtime')     and (not v_retiree or v_keys ? 'overtime');
  v_sh := public.payroll_close_feature_on(p_user, 'shift_report') and (not v_retiree or v_keys ? 'shift_report') and v_part;
  v_ex := public.payroll_close_feature_on(p_user, 'expense')      and (not v_retiree or v_keys ? 'expense');
  if not v_retiree then
    -- 受理まち：ナビの数え方（App.tsx useOvertimePendingCount）に、締め日までの勤務・自分あて以外の条件を足したもの
    select count(*) into v_otp from public.overtime_reports o
     where o.reviewer_id = p_user and o.reviewer_id <> o.applicant_id and o.entry_type = 'manual'
       and o.status in ('requested', 'reported') and o.work_date <= p_close;
    -- 確認まち：ナビの数え方（useShiftPendingCount）に、締め日までの勤務の条件を足したもの
    select count(*) into v_srp from public.shift_reports s
     where s.reviewer_id = p_user and s.reviewer_id <> s.applicant_id
       and s.status in ('pending', 'resubmitted') and s.work_date <= p_close;
  end if;
  return public.payroll_close_lines(p_close, v_ot, v_sh, v_ex, v_ex and not v_part, v_otp, v_srp, null);
end $$;

-- ───────────────────────────────────────────────
-- 5. 送る（cron 毎日 10:00 JST に呼ぶ。送る日〜締め日のあいだで、まだ送っていなければ送る）
-- ───────────────────────────────────────────────
create or replace function public.payroll_close_notice_daily()
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_set jsonb; v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_close date; v_send date; v_title text; v_lines jsonb; v_nid uuid; v_n int := 0; u record;
begin
  select value into v_set from public.app_settings where key = 'payroll_close_notice';
  -- 🚨 設定が無い・OFF のときは送らない（送らない側に倒す）
  if v_set is null or not coalesce((v_set ->> 'enabled')::boolean, false) then
    return jsonb_build_object('sent', false, 'why', 'disabled');
  end if;
  v_close := public.payroll_close_date_for(v_today);
  if v_close < coalesce((v_set ->> 'start_close_date')::date, '2999-01-01'::date) then
    return jsonb_build_object('sent', false, 'why', 'before_start', 'close', v_close);
  end if;
  v_send := public.payroll_close_send_date(v_close);
  if v_today < v_send or v_today > v_close then
    return jsonb_build_object('sent', false, 'why', 'not_today', 'close', v_close, 'send', v_send);
  end if;
  -- 二重に送らない：記録を先に1行だけ作り、作れなかったら（もう送った）終わる
  insert into public.payroll_close_notices (close_date) values (v_close) on conflict do nothing;
  if not found then return jsonb_build_object('sent', false, 'why', 'already_sent', 'close', v_close); end if;

  v_title := public.payroll_close_jp_date(v_close) || 'は給与の締め日です';
  for u in select p.id from public.profiles p
            where p.is_active or public.is_retiree_in_grace(p.id) loop
    v_lines := public.payroll_close_compose(u.id, v_close);
    if jsonb_array_length(v_lines) = 0 then continue; end if;
    v_nid := null;
    if coalesce((v_set ->> 'bell')::boolean, true) then
      -- 🚨 message に「お知らせ」「リマインド」を入れない（ベルの飛び先が連絡板になる）
      -- event_key があるときだけスマホに乗る（enqueue_push_notification）。スマホ OFF なら null
      insert into public.notifications (user_id, message, sub_message, source_type, event_key, reference_id, banner_dismissed)
      values (u.id, v_title, '申請の確認をお願いします（くわしくはホームの案内をご覧ください）', 'payroll_close',
              case when coalesce((v_set ->> 'push')::boolean, true) then 'payroll:close_notice' end,
              v_close::text, true)
      returning id into v_nid;
    end if;
    insert into public.payroll_close_notice_recipients (close_date, user_id, notification_id)
    values (v_close, u.id, v_nid) on conflict do nothing;
    v_n := v_n + 1;
  end loop;
  update public.payroll_close_notices set recipient_count = v_n where close_date = v_close;
  return jsonb_build_object('sent', true, 'close', v_close, 'recipients', v_n);
end $$;

-- ───────────────────────────────────────────────
-- 6. ホームのバナー（本人）
-- ───────────────────────────────────────────────
-- 送った相手に入っていて、15日の終わり（JST）までなら返す。閉じていても返す（dismissed で画面が決める。ベルから来たら開き直す）
create or replace function public.my_payroll_close_notice()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid(); v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_close date := public.payroll_close_date_for((now() at time zone 'Asia/Tokyo')::date);
  v_set jsonb; r record; v_lines jsonb;
begin
  if v_uid is null then return null; end if;
  select value into v_set from public.app_settings where key = 'payroll_close_notice';
  if v_set is null or not coalesce((v_set ->> 'banner')::boolean, true) then return null; end if;
  select * into r from public.payroll_close_notice_recipients x where x.close_date = v_close and x.user_id = v_uid;
  if not found then return null; end if;
  if now() >= ((v_close + 1)::timestamp at time zone 'Asia/Tokyo') then return null; end if;
  v_lines := public.payroll_close_compose(v_uid, v_close);
  if jsonb_array_length(v_lines) = 0 then return null; end if;
  return jsonb_build_object('close_date', v_close, 'title', public.payroll_close_jp_date(v_close) || 'は給与の締め日です',
                            'dismissed', r.dismissed_at is not null, 'lines', v_lines);
end $$;

-- 閉じる（ベルも既読にする）／開き直す（ベルから来たとき）
create or replace function public.set_payroll_close_notice_dismissed(p_close date, p_dismissed boolean)
returns boolean language plpgsql volatile security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_nid uuid;
begin
  if v_uid is null then return false; end if;
  update public.payroll_close_notice_recipients
     set dismissed_at = case when p_dismissed then now() end
   where close_date = p_close and user_id = v_uid
  returning notification_id into v_nid;
  if not found then return false; end if;
  if p_dismissed and v_nid is not null then
    update public.notifications set read = true, read_at = coalesce(read_at, now())
     where id = v_nid and user_id = v_uid;
  end if;
  return true;
end $$;

-- ───────────────────────────────────────────────
-- 7. 管理画面（管理者だけ）：見え方のプレビュー・次に送る日・前回・自分に試しに送る
-- ───────────────────────────────────────────────
create or replace function public.payroll_close_notice_admin_preview(
  p_ot boolean, p_shift boolean, p_expense boolean, p_commuter boolean,
  p_ot_pending int, p_sr_pending int, p_lines_override jsonb default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_set jsonb; v_close date; v_start date; v_last record;
begin
  if coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'admin' then
    raise exception '管理者だけが使えます';
  end if;
  select value into v_set from public.app_settings where key = 'payroll_close_notice';
  v_close := public.payroll_close_date_for(v_today);
  -- 今月分の送る日を過ぎて送り済みなら、次の月を「次に送る」に出す
  if exists (select 1 from public.payroll_close_notices n where n.close_date = v_close) then
    v_close := public.payroll_close_date_for(v_close + 1);
  end if;
  v_start := (v_set ->> 'start_close_date')::date;
  if v_start is not null and v_close < v_start then v_close := v_start; end if;
  select * into v_last from public.payroll_close_notices n order by n.close_date desc limit 1;
  return jsonb_build_object(
    'title', public.payroll_close_jp_date(v_close) || 'は給与の締め日です',
    'lines', public.payroll_close_lines(v_close, p_ot, p_shift, p_expense, p_commuter, p_ot_pending, p_sr_pending, p_lines_override),
    'next_close', v_close, 'next_send', public.payroll_close_send_date(v_close),
    'enabled', coalesce((v_set ->> 'enabled')::boolean, false),
    'last_close', v_last.close_date, 'last_sent_at', v_last.sent_at, 'last_count', v_last.recipient_count);
end $$;

-- 自分に試しに送る：ベル1件だけ（🚨 送った記録には書かない＝本番の送信を止めない）。保存済みの文を使う
create or replace function public.payroll_close_notice_test_send(
  p_ot boolean, p_shift boolean, p_expense boolean, p_commuter boolean, p_ot_pending int, p_sr_pending int)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_close date; v_lines jsonb; v_sub text;
begin
  if v_uid is null or coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'admin' then
    raise exception '管理者だけが使えます';
  end if;
  v_close := public.payroll_close_date_for((now() at time zone 'Asia/Tokyo')::date);
  v_lines := public.payroll_close_lines(v_close, p_ot, p_shift, p_expense, p_commuter, p_ot_pending, p_sr_pending, null);
  if jsonb_array_length(v_lines) = 0 then raise exception '届く行がありません（本文の行が1つもない組み合わせです）'; end if;
  -- 試しのときは本文をベルに入れる（バナーは出ないため）
  select string_agg(e ->> 'text', ' ／ ') into v_sub from jsonb_array_elements(v_lines) e;
  insert into public.notifications (user_id, message, sub_message, source_type, event_key, reference_id, banner_dismissed)
  values (v_uid, '【試し】' || public.payroll_close_jp_date(v_close) || 'は給与の締め日です', v_sub,
          'payroll_close_test', 'payroll:close_notice', 'test', true);
  return jsonb_build_object('ok', true);
end $$;

-- ───────────────────────────────────────────────
-- 8. 権限：🚨 新しい関数は anon から明示的に外す（from public だけでは外れない）
-- ───────────────────────────────────────────────
revoke execute on function public.payroll_close_date_for(date) from public, anon, authenticated;
revoke execute on function public.payroll_close_send_date(date) from public, anon, authenticated;
revoke execute on function public.payroll_close_jp_date(date) from public, anon, authenticated;
revoke execute on function public.payroll_close_lines(date, boolean, boolean, boolean, boolean, int, int, jsonb) from public, anon, authenticated;
revoke execute on function public.payroll_close_feature_on(uuid, text) from public, anon, authenticated;
revoke execute on function public.payroll_close_compose(uuid, date) from public, anon, authenticated;
revoke execute on function public.payroll_close_notice_daily() from public, anon, authenticated;
revoke execute on function public.my_payroll_close_notice() from public, anon;
revoke execute on function public.set_payroll_close_notice_dismissed(date, boolean) from public, anon;
revoke execute on function public.payroll_close_notice_admin_preview(boolean, boolean, boolean, boolean, int, int, jsonb) from public, anon;
revoke execute on function public.payroll_close_notice_test_send(boolean, boolean, boolean, boolean, int, int) from public, anon;
grant execute on function public.my_payroll_close_notice() to authenticated, retiree;
grant execute on function public.set_payroll_close_notice_dismissed(date, boolean) to authenticated, retiree;
grant execute on function public.payroll_close_notice_admin_preview(boolean, boolean, boolean, boolean, int, int, jsonb) to authenticated;
grant execute on function public.payroll_close_notice_test_send(boolean, boolean, boolean, boolean, int, int) to authenticated;

-- ───────────────────────────────────────────────
-- 9. cron：毎日 10:00 JST（01:00 UTC）に送る／毎月2日 3:20 JST（1日 18:20 UTC）に2年より古い記録を消す
-- ───────────────────────────────────────────────
select cron.unschedule('payroll-close-notice-daily') where exists (select 1 from cron.job where jobname = 'payroll-close-notice-daily');
select cron.schedule('payroll-close-notice-daily', '0 1 * * *', $cron$select public.payroll_close_notice_daily();$cron$);
select cron.unschedule('purge-payroll-close-notices-monthly') where exists (select 1 from cron.job where jobname = 'purge-payroll-close-notices-monthly');
select cron.schedule('purge-payroll-close-notices-monthly', '20 18 1 * *',
  $cron$delete from public.payroll_close_notices where close_date < ((now() at time zone 'Asia/Tokyo')::date - interval '2 years');$cron$);

commit;
