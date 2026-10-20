-- ============================================================
-- 2026-10-20  休職（段4：スマホのお知らせ）
-- 計画：docs/計画-休職と手続き.md（決まったこと 8・レビューの結果）
-- ============================================================
-- ・push_leave_blocked_ids(p_user_ids)：今日休職中で、スマホのお知らせを「受け取らない」（staff_leaves.push_on=false・初めの値）人
--   共用の Edge Function push-dispatch・send-push が使う（service だけ）。
--   🚨 安否確認・緊急（push-dispatch の isUrgent＝行の urgent・EVENT_MAP の urgent・safety: ／ send-push の urgent）は止めない
--   🚨 既存のミュート（受信時間外は保留して後で届ける）とは別。休職は「送らずに捨てる」（ベルには残る）
--
-- ロールバック手順:
--   drop function if exists push_leave_blocked_ids(uuid[]);
--   （Edge Function は呼べなくても fail-open＝いつもどおり送るので、関数だけ消しても止まらない）

create or replace function public.push_leave_blocked_ids(p_user_ids uuid[])
returns setof uuid
language sql stable security definer set search_path to 'public'
as $$
  select l.user_id from staff_leaves l
   where l.user_id = any (p_user_ids)
     and l.ended_at is null and l.cancelled_at is null and not l.push_on
     and staff_on_leave(l.user_id);
$$;
revoke execute on function public.push_leave_blocked_ids(uuid[]) from public, anon, authenticated;
