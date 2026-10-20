-- ============================================================
-- 2026-10-20  休職（段3の4：残りの宛先・本人あての自動のお知らせ・日付の直し忘れのベル）
-- 計画：docs/計画-休職と手続き.md（段0のあとの一問一答・段3の1の2回目のレビュー）
-- ============================================================
-- ・unavailable_approver_ids を退職者の役割（retiree）にも（退職者の申請の知らせの宛先を lib/notificationDispatch が絞るため）
-- ・staff_leave_keys(uid)：休職中に使える機能（基本＋この人だけ足す−引く）。my_access_state と同じ決め方
-- ・user_has_feature_permission／has_feature_permission：休職中は「休職中に使える機能」にあるものだけ true
--   （本人あての自動のお知らせ・休職中の人のデータの読み書きが、休職中に使えない機能で動かないように）
-- ・set_board_approver_ids（3万円超の全員承認の対象者）：休職中の決裁者を外す（画面のプレビュー PurchaseRequestForm と同じ）
-- ・notify_safety_urgent（安否確認の「助けが必要」）：休職中のマネージャー以上には送らない（ユーザー確定）
-- ・payroll_close_compose（締め日のお知らせ）：給与期間がまるごと休職中なら送らない。休職中は受理まち・確認まちの行を出さない（経理へ回るため）
-- ・staff_admin_ids()：在籍中の管理者のアカウント（催促を経理へ回すため・service だけ）
-- ・staff_leave_daily_notices()：日付の直し忘れを防ぐベル（毎朝 9:00 JST・マネージャー以上と管理者・休職中の本人は除く・スマホなし）
--     ① 復職日の7日前と前日「📋 ◯◯さんが 3/1 に復職予定です。日付が変わる場合は、管理者が［休職を修正］から直します。」
--     ② 休職の初日にその人あての受理待ちが残っていれば「📋 ◯◯さんあての受理待ちが2件あります。付け替えてください。」
--     ③ 毎月1日、復職日が未定の休職中の方がいれば「📋 復職日が未定の方が1人います。」
--
-- ロールバック手順:
--   select cron.unschedule('staff-leave-daily-notices');
--   drop function if exists staff_leave_daily_notices(), staff_admin_ids(), staff_leave_keys(uuid), staff_leave_feature_ok(uuid, text), board_approver_ids_for(uuid), staff_on_leave_ids(boolean);
--   user_has_feature_permission／has_feature_permission／set_board_approver_ids／notify_safety_urgent／payroll_close_compose は
--   各定義のコメントの「元」に戻す（＝休職の行を外す）

grant execute on function public.unavailable_approver_ids() to retiree;

-- ── 休職中に使える機能 ───────────────────────────────────
create or replace function public.staff_leave_keys(p_user uuid)
returns text[]
language sql stable security definer set search_path to 'public'
as $$
  select array(
    select distinct k
      from unnest(
        coalesce((select array(select jsonb_array_elements_text(s.value -> 'keys')) from app_settings s where s.key = 'leave_feature_keys'), '{}')
        || coalesce((select l.features_add from staff_leaves l where l.user_id = p_user and l.ended_at is null and l.cancelled_at is null order by l.start_date desc limit 1), '{}')
      ) k
     where not (k = any (coalesce((select l.features_remove from staff_leaves l where l.user_id = p_user and l.ended_at is null and l.cancelled_at is null order by l.start_date desc limit 1), '{}'))));
$$;

-- その人がその機能を使えるか（休職中なら「休職中に使える機能」にあるときだけ）。休職中でなければ true
create or replace function public.staff_leave_feature_ok(p_user uuid, p_feature text)
returns boolean
language sql stable security definer set search_path to 'public'
as $$ select not staff_on_leave(p_user) or p_feature = any (staff_leave_keys(p_user)); $$;

-- 元：select coalesce(exists(管理者) or exists(役職の権限), false)
CREATE OR REPLACE FUNCTION public.user_has_feature_permission(p_user uuid, p_feature text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce(
    exists (select 1 from auth.users u
             where u.id = p_user and (u.raw_app_meta_data ->> 'role') = 'admin')
    or (exists (
      select 1
        from profiles p
        join roles r
          on r.id = p.role_id
          or (p.role_id is null and r.name = p.role_title)
        join feature_permissions fp
          on fp.role_id = r.id and fp.feature_key = p_feature
       where p.id = p_user and fp.enabled
    ) and staff_leave_feature_ok(p_user, p_feature)),   -- 休職中は「休職中に使える機能」だけ（2026-10-20）
    false);
$function$;

-- 元：select coalesce(is_admin() or exists(役職の権限), false)
CREATE OR REPLACE FUNCTION public.has_feature_permission(p_feature text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- 🚨 全体を coalesce で包み、NULL を返さない
  select coalesce(
    is_admin()
    or (exists (
      select 1
      from profiles p
      join roles r
        on r.id = p.role_id
        or (p.role_id is null and r.name = p.role_title)
      join feature_permissions fp
        on fp.role_id = r.id and fp.feature_key = p_feature
      where p.id = auth.uid() and fp.enabled
    ) and staff_leave_feature_ok(auth.uid(), p_feature)), false);   -- 休職中は「休職中に使える機能」だけ（2026-10-20）
$function$;

-- ── 3万円超の全員承認の対象者 ──────────────────────────────
-- 🚨 set_board_approver_ids は security definer ではない（呼ぶ人の権限で動く）。staff_on_leave は画面から呼べないので、
--    休職を見る部分だけを definer の関数に出す（返すのは決裁者の役職の人だけ＝unavailable_approver_ids と同じ範囲）
create or replace function public.board_approver_ids_for(p_applicant uuid)
returns uuid[]
language sql stable security definer set search_path to 'public'
as $$
  select array_agg(p.id) from profiles p
   where p.is_active = true and role_is_board_approver(p.id) and not staff_on_leave(p.id) and p.id <> p_applicant;
$$;
revoke execute on function public.board_approver_ids_for(uuid) from public, anon;
grant execute on function public.board_approver_ids_for(uuid) to authenticated, retiree;

-- 元：SELECT array_agg(p.id) INTO NEW.board_approver_ids FROM profiles p WHERE p.is_active = true AND role_is_board_approver(p.id) AND p.id != NEW.user_id
CREATE OR REPLACE FUNCTION public.set_board_approver_ids()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.amount > 30000 AND NEW.request_type = 'purchase_request' AND NOT NEW.president_self_judgment THEN
    IF TG_OP = 'INSERT' OR NEW.board_approver_ids IS NOT DISTINCT FROM OLD.board_approver_ids THEN
      -- 休職中の決裁者は外す（2026-10-20・画面のプレビューと同じ）
      NEW.board_approver_ids := public.board_approver_ids_for(NEW.user_id);
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- ── 安否確認の「助けが必要」 ─────────────────────────────
-- 元：select p.id from profiles p where p.is_active = true and role_is_manager_plus(p.id)
CREATE OR REPLACE FUNCTION public.notify_safety_urgent(p_check_id uuid, p_target_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_title text;
  v_created_by uuid;
  v_name text;
  r record;
begin
  select title, created_by into v_title, v_created_by from safety_checks where id = p_check_id;
  select name into v_name from profiles where id = p_target_user_id;

  for r in
    select distinct x.id from (
      select v_created_by as id where v_created_by is not null
      union
      select p.id from profiles p
       where p.is_active = true
         and role_is_manager_plus(p.id)
         and not staff_on_leave(p.id)   -- 休職中のマネージャー以上には送らない（2026-10-20・ユーザー確定）
    ) x
    where x.id is not null and x.id <> p_target_user_id
  loop
    insert into notifications (user_id, message, sub_message, source_type, reference_id, event_key, read)
    values (r.id,
            coalesce(v_name, 'スタッフ') || 'さんが助けを必要としています',
            v_title,
            'safety_check_urgent', p_check_id::text, 'safety:urgent', false);
  end loop;
end;
$function$;

-- ── 締め日のお知らせ ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.payroll_close_compose(p_user uuid, p_close date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_p record; v_retiree boolean := false; v_keys jsonb := null; v_part boolean;
  v_ot boolean; v_sh boolean; v_ex boolean; v_otp int := 0; v_srp int := 0;
  v_period_start date;
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
  -- 休職（2026-10-20・ユーザー確定）：給与期間（前の月の16日〜締め日）がまるごと休職中なら送らない
  v_period_start := ((p_close - interval '1 month')::date + 1);
  if not v_retiree and public.staff_leave_active_on(p_user, v_period_start) and public.staff_leave_active_on(p_user, p_close)
     and exists (select 1 from public.staff_leaves l
                  where l.user_id = p_user and l.cancelled_at is null and l.start_date <= v_period_start
                    and (l.return_date is null or l.return_date > p_close)
                    and (l.ended_at is null or (l.ended_at at time zone 'Asia/Tokyo')::date > p_close)) then
    return '[]'::jsonb;
  end if;
  v_part := coalesce(v_p.employment_type, '正社員') = 'パート';
  v_ot := public.payroll_close_feature_on(p_user, 'overtime')     and (not v_retiree or v_keys ? 'overtime');
  v_sh := public.payroll_close_feature_on(p_user, 'shift_report') and (not v_retiree or v_keys ? 'shift_report') and v_part;
  v_ex := public.payroll_close_feature_on(p_user, 'expense')      and (not v_retiree or v_keys ? 'expense');
  -- 休職中は受理まち・確認まちを数えない（残った申請は経理へ回る・2026-10-20）
  if not v_retiree and not public.staff_on_leave(p_user) then
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
end $function$;

-- ── 在籍中の管理者のアカウント（催促を経理へ回す）──────────────────
create or replace function public.staff_admin_ids()
returns setof uuid
language sql stable security definer set search_path to 'public'
as $$
  select u.id from auth.users u join profiles p on p.id = u.id
   where (u.raw_app_meta_data ->> 'role') = 'admin' and p.is_active = true
   order by u.created_at;
$$;

-- ── 休職中の人の一覧（Edge Function が宛先から外すため・service だけ）──────────
-- p_quiet_only = true：連絡板のお知らせを「受け取らない」人だけ（管理者からのお知らせのスマホ・ベルを止める・ユーザー確定）
-- p_quiet_only = false：今日休職中の全員（定期リマインドの名指しは休職中は送らない・ユーザー確定）
create or replace function public.staff_on_leave_ids(p_quiet_only boolean default false)
returns setof uuid
language sql stable security definer set search_path to 'public'
as $$
  select l.user_id from staff_leaves l
   where l.ended_at is null and l.cancelled_at is null and staff_on_leave(l.user_id)
     and (not p_quiet_only or not l.board_opt_in);
$$;
revoke execute on function public.staff_on_leave_ids(boolean) from public, anon, authenticated;

-- ── 日付の直し忘れを防ぐベル ──────────────────────────────
create or replace function public.staff_leave_daily_notices()
returns integer
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_n integer := 0;
  l record;
  v_cnt integer;
  v_msg text;
  v_src text;
begin
  for l in
    select sl.*, p.name
      from staff_leaves sl join profiles p on p.id = sl.user_id
     where sl.ended_at is null and sl.cancelled_at is null and p.is_active
  loop
    v_msg := null;
    -- ① 復職日の7日前と前日
    if l.return_date is not null and (l.return_date - 7 = v_today or l.return_date - 1 = v_today) then
      v_msg := '📋 ' || coalesce(l.name, '') || 'さんが ' || to_char(l.return_date, 'FMMM/FMDD') || ' に復職予定です。日付が変わる場合は、管理者が［休職を修正］から直します。';
      v_src := 'staff_leave:return_soon';
    end if;
    -- ② 休職の初日に、その人あての受理待ちが残っている
    if l.start_date = v_today then
      select (select count(*) from leave_requests where approver_id = l.user_id and status = 'pending')
           + (select count(*) from leave_requests where approver2_id = l.user_id and status in ('pending', 'manager_approved'))
           + (select count(*) from overtime_reports where reviewer_id = l.user_id and status not in ('confirmed', 'cancelled') and applicant_id is distinct from l.user_id)
           + (select count(*) from shift_reports where reviewer_id = l.user_id and status = 'pending')
        into v_cnt;
      if v_cnt > 0 then
        v_msg := '📋 ' || coalesce(l.name, '') || 'さんあての受理待ちが' || v_cnt || '件あります。付け替えてください。';
        v_src := 'staff_leave:pending';
      end if;
    end if;
    if v_msg is not null then
      insert into notifications (user_id, message, source_type, reference_id, read)
      select x.id, v_msg, v_src, l.user_id::text, false
        from (select p.id from profiles p where p.is_active and role_is_manager_plus(p.id) and not staff_on_leave(p.id)
              union select staff_admin_ids()) x
       where x.id <> l.user_id;
      get diagnostics v_cnt = row_count; v_n := v_n + v_cnt;
    end if;
  end loop;

  -- ③ 毎月1日：復職日が未定の休職中の方
  if extract(day from v_today) = 1 then
    select count(*) into v_cnt from staff_leaves sl join profiles p on p.id = sl.user_id
     where sl.ended_at is null and sl.cancelled_at is null and sl.return_date is null and sl.start_date <= v_today and p.is_active;
    if v_cnt > 0 then
      insert into notifications (user_id, message, source_type, reference_id, read)
      select x.id, '📋 復職日が未定の方が' || v_cnt || '人います。', 'staff_leave:undecided', to_char(v_today, 'YYYY-MM-DD'), false
        from (select p.id from profiles p where p.is_active and role_is_manager_plus(p.id) and not staff_on_leave(p.id)
              union select staff_admin_ids()) x;
      get diagnostics v_cnt = row_count; v_n := v_n + v_cnt;
    end if;
  end if;
  return v_n;
end;
$$;

select cron.unschedule('staff-leave-daily-notices') where exists (select 1 from cron.job where jobname = 'staff-leave-daily-notices');
select cron.schedule('staff-leave-daily-notices', '0 0 * * *', $$select public.staff_leave_daily_notices()$$);

revoke execute on function public.staff_leave_keys(uuid) from public, anon, authenticated;
revoke execute on function public.staff_leave_feature_ok(uuid, text) from public, anon, authenticated;
revoke execute on function public.staff_admin_ids() from public, anon, authenticated;
revoke execute on function public.staff_leave_daily_notices() from public, anon, authenticated;
