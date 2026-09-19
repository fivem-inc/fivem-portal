-- 退職の1段目・調整不要のレビュー指摘を直す（2026-09-19・UI/UX とシニアエンジニアの2体レビュー）
-- 🚨 3つの関数は本番の実定義（pg_get_functiondef・2026-09-19 取得）から起こした。差分は「2026-09-19 レビュー」の注記の行だけ
--  1. retire_daily：1人ずつ失敗を受け止める（1件の例外でその夜の全員ぶんが取り消されていた）
--  2. retire_apply：休暇の1人目の承認者の付け替えは「受理前（pending）」だけ（受理した人の記録を書き換えない）
--  3. trg_leave_shift_adjust_not_needed：奨励日→ふつうの日に変えたら「未」に戻す
--  4. retire_purchase_pending：退職者が承認者のまま残っている購入申請の件数（リーダー確認待ちも含む）。
--     画面から直接数えると RLS で自分が関わる行しか読めず、静かに0件になるため security definer で数える

CREATE OR REPLACE FUNCTION public.retire_apply(p_user uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_admin uuid;
  v_n integer := 0;
  v_c integer;
begin
  -- 在籍中で、退職日が入っていて、承認待ちではない人だけ
  update profiles p
     set is_active = false,
         retired_at = now(),
         retired_role_id = p.role_id,
         retired_employment_type = p.employment_type,
         retiree_access_until = coalesce(p.retiree_access_until, retire_access_default(p.retire_date))
   where p.id = p_user
     and p.is_active = true
     and p.retire_date is not null
     and coalesce(p.approval_status, '') <> 'pending';
  if not found then return 0; end if;

  -- 付け替え先＝「管理者」アカウント（app_metadata.role='admin' かつ在籍・本人以外）。
  -- 🚨 2026-09-18 時点で1つだけ。複数あれば最も古いもの。無ければ付け替えない（記録も残さない）
  select u.id into v_admin
    from auth.users u join profiles pr on pr.id = u.id
   where u.raw_app_meta_data->>'role' = 'admin' and pr.is_active = true and u.id <> p_user
   order by u.created_at
   limit 1;
  if v_admin is null then return 0; end if;

  -- 残業：確定・取り消し以外は、まだ確認者が関わる
  with t as (
    update overtime_reports set reviewer_id = v_admin
     where reviewer_id = p_user and status not in ('confirmed', 'cancelled')
    returning id)
  insert into retire_reassignments (retired_user_id, table_name, row_id, column_name, to_user_id)
  select p_user, 'overtime_reports', id, 'reviewer_id', v_admin from t;
  get diagnostics v_c = row_count; v_n := v_n + v_c;

  -- 勤務変更報告：確認待ち
  with t as (
    update shift_reports set reviewer_id = v_admin
     where reviewer_id = p_user and status = 'pending'
    returning id)
  insert into retire_reassignments (retired_user_id, table_name, row_id, column_name, to_user_id)
  select p_user, 'shift_reports', id, 'reviewer_id', v_admin from t;
  get diagnostics v_c = row_count; v_n := v_n + v_c;

  -- 休暇：1人目・2人目の承認者（受理前）
  with t as (
    -- 🚨 1人目は「まだ受理していない」行だけ（manager_approved は1人目がもう受理済み＝受理した人の記録を書き換えない・2026-09-19 レビュー）
    update leave_requests set approver_id = v_admin
     where approver_id = p_user and status = 'pending'
    returning id)
  insert into retire_reassignments (retired_user_id, table_name, row_id, column_name, to_user_id)
  select p_user, 'leave_requests', id, 'approver_id', v_admin from t;
  get diagnostics v_c = row_count; v_n := v_n + v_c;

  with t as (
    update leave_requests set approver2_id = v_admin
     where approver2_id = p_user and status in ('pending', 'manager_approved')
    returning id)
  insert into retire_reassignments (retired_user_id, table_name, row_id, column_name, to_user_id)
  select p_user, 'leave_requests', id, 'approver2_id', v_admin from t;
  get diagnostics v_c = row_count; v_n := v_n + v_c;

  -- 🚨 備品購入申請（承認者が複数・承認済みの人と未承認の人が混ざる）は自動では付け替えない。
  --    チェック表に「未処理の申請」として出し、既存の［承認者を変更］で直す（2026-09-19）
  return v_n;
end;
$function$;

CREATE OR REPLACE FUNCTION public.retire_daily()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r record;
  v_count integer := 0;
begin
  for r in
    select id from profiles
     where is_active = true
       and retire_date is not null
       and retire_date < (now() at time zone 'Asia/Tokyo')::date
       and coalesce(approval_status, '') <> 'pending'
  loop
    -- 🚨 1人ずつ失敗を受け止める（2026-09-19 レビュー）。受け止めないと、付け替え先の申請のトリガー
    --    （enforce_furikae_no_double_count など）が1件でも例外を出すと、その夜の全員ぶんが取り消される。
    --    失敗した人は在籍のまま残るので、チェック表に「自動の切り替えに失敗しています」と出る（退職日 < 今日 かつ 在籍）
    begin
      perform retire_apply(r.id);
      v_count := v_count + 1;
    exception when others then
      raise warning '[retire_daily] % の退職の切り替えに失敗しました: %', r.id, sqlerrm;
    end;
  end loop;
  return v_count;
end;
$function$;

CREATE OR REPLACE FUNCTION public.trg_leave_shift_adjust_not_needed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if coalesce(new.shift_adjust_status, 'pending') = 'pending'
     and public.leave_all_encouraged(new.leave_dates, new.start_date, new.end_date) then
    new.shift_adjust_status := 'not_needed';
  -- 🚨 逆向き（2026-09-19 レビュー）：奨励日だけだった休暇をふつうの日に変えたら「未」に戻す（調整の催促が来るように）
  elsif tg_op = 'UPDATE'
     and new.shift_adjust_status = 'not_needed'
     and public.leave_all_encouraged(old.leave_dates, old.start_date, old.end_date)
     and not public.leave_all_encouraged(new.leave_dates, new.start_date, new.end_date) then
    new.shift_adjust_status := 'pending';
  end if;
  return new;
end;
$function$;

create or replace function public.retire_purchase_pending(p_user uuid)
returns integer
language plpgsql
stable
security definer
set search_path = public
as $$
declare v_n integer;
begin
  if not is_manager_plus() then raise exception 'マネージャー以上だけが見られます' using errcode = '42501'; end if;
  select count(*) into v_n
    from purchase_requests r
   where (r.status = 'pending_leader'  and r.leader_id = p_user)
      or (r.status = 'pending_manager' and p_user = any (coalesce(r.requested_manager_ids, '{}')))
      or (r.status = 'pending_board'   and p_user = any (coalesce(r.board_approver_ids, '{}')));
  return v_n;
end;
$$;
revoke execute on function public.retire_purchase_pending(uuid) from public, anon;
grant execute on function public.retire_purchase_pending(uuid) to authenticated;
revoke execute on function public.retire_apply(uuid) from public, anon, authenticated;
revoke execute on function public.retire_daily() from public, anon, authenticated;
revoke execute on function public.trg_leave_shift_adjust_not_needed() from public, anon, authenticated;
