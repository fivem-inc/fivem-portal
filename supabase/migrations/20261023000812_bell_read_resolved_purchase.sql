-- ベルの「承認待ち」を、備品購入申請でも済んだら自動で既読にする（2026-10-23 ユーザー確定・20261022213458 の続き）
--
-- 実測（2026-10-23）：備品購入申請の「承認待ち」（purchase_request:pending_approval）が未読で16件。全部もう済んだ申請（board_approved など）。
--
-- 決まり：
--   ① 申請の状態（status）が変わったら、その申請の「承認待ち」を宛先の全員ぶん既読（承認・差し戻し・審議から次へ、のどれでも前の段のお知らせは役目を終えている）
--   ② 状態が同じで承認する人が変わったら（leader_id・requested_manager_ids・board_approver_ids）、外れた人の分だけ既読
--   ③ 承認する人が意見・回答を出したら（purchase_request_manager_opinions に入ったとき）、その人の分だけ既読
--      （全員承認・審議では、ほかの人が回答するまで状態が変わらないため。回答を直したとき＝UPDATE では動かさない：
--        審議の「意見がそろいました（最終決定してください）」は回答のあとに届くので、直しただけで消さない）
--   🚨 次の段へのお知らせは、画面（PurchaseRequestForm・PurchaseApprovals）が書き換えた「あと」に入れている（2026-10-23 確認）。DB では作っていない
--   ・申請者あての結果のお知らせ（source_type 'purchase_request'）は対象外（待ちではない）
--
-- 関数 bell_read_resolved_pending は本番の実定義（20261022213458 と同じ・2026-10-23 突き合わせ済み）に purchase_requests の枝を足した

create or replace function public.bell_read_resolved_pending()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prefix text := case tg_table_name
    when 'leave_requests'    then 'leave_request'
    when 'shift_reports'     then 'shift_report'
    when 'overtime_reports'  then 'overtime_request'
    when 'purchase_requests' then 'purchase_request'
  end;
  o jsonb := to_jsonb(old);
  n jsonb := to_jsonb(new);
  v_old_ids uuid[] := '{}';
begin
  if v_prefix is null then return null; end if;

  if (o->>'status') is distinct from (n->>'status') then
    update notifications
       set read = true, read_at = coalesce(read_at, now()), banner_dismissed = true
     where reference_id = new.id::text
       and source_type in (v_prefix || ':pending_approval', v_prefix || ':pending_resubmit')
       and read = false;
    return null;
  end if;

  -- 状態は同じで受理者だけが変わった（付け替え）→ 前の受理者の分だけ
  if tg_table_name = 'leave_requests' then
    if (o->>'approver_id') is not null and (o->>'approver_id') is distinct from (n->>'approver_id') then
      v_old_ids := v_old_ids || (o->>'approver_id')::uuid;
    end if;
    if (o->>'approver2_id') is not null and (o->>'approver2_id') is distinct from (n->>'approver2_id') then
      v_old_ids := v_old_ids || (o->>'approver2_id')::uuid;
    end if;
  elsif tg_table_name = 'purchase_requests' then
    if (o->>'leader_id') is not null and (o->>'leader_id') is distinct from (n->>'leader_id') then
      v_old_ids := v_old_ids || (o->>'leader_id')::uuid;
    end if;
    -- 配列から外れた人（前にいて今いない人）。🚨 列が null のとき to_jsonb は JSON の null になる（SQL の null ではない）ので型で見る
    v_old_ids := v_old_ids || coalesce(array(
      select x::uuid from jsonb_array_elements_text(case when jsonb_typeof(o->'requested_manager_ids') = 'array' then o->'requested_manager_ids' else '[]'::jsonb end) x
      except select y::uuid from jsonb_array_elements_text(case when jsonb_typeof(n->'requested_manager_ids') = 'array' then n->'requested_manager_ids' else '[]'::jsonb end) y), '{}');
    v_old_ids := v_old_ids || coalesce(array(
      select x::uuid from jsonb_array_elements_text(case when jsonb_typeof(o->'board_approver_ids') = 'array' then o->'board_approver_ids' else '[]'::jsonb end) x
      except select y::uuid from jsonb_array_elements_text(case when jsonb_typeof(n->'board_approver_ids') = 'array' then n->'board_approver_ids' else '[]'::jsonb end) y), '{}');
  else
    if (o->>'reviewer_id') is not null and (o->>'reviewer_id') is distinct from (n->>'reviewer_id') then
      v_old_ids := v_old_ids || (o->>'reviewer_id')::uuid;
    end if;
  end if;

  if cardinality(v_old_ids) > 0 then
    update notifications
       set read = true, read_at = coalesce(read_at, now()), banner_dismissed = true
     where reference_id = new.id::text
       and source_type = v_prefix || ':pending_approval'
       and user_id = any(v_old_ids)
       and read = false;
  end if;
  return null;
end;
$$;

revoke execute on function public.bell_read_resolved_pending() from public;
revoke execute on function public.bell_read_resolved_pending() from anon;
revoke execute on function public.bell_read_resolved_pending() from authenticated;

drop trigger if exists trg_bell_read_resolved on public.purchase_requests;
create trigger trg_bell_read_resolved
  after update of status, leader_id, requested_manager_ids, board_approver_ids on public.purchase_requests
  for each row
  when (old.status is distinct from new.status
        or old.leader_id is distinct from new.leader_id
        or old.requested_manager_ids is distinct from new.requested_manager_ids
        or old.board_approver_ids is distinct from new.board_approver_ids)
  execute function public.bell_read_resolved_pending();

-- ③ 回答を出した人の「承認待ち」
create or replace function public.bell_read_purchase_opinion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update notifications
     set read = true, read_at = coalesce(read_at, now()), banner_dismissed = true
   where reference_id = new.purchase_request_id::text
     and source_type = 'purchase_request:pending_approval'
     and user_id = new.manager_id
     and read = false;
  return null;
end;
$$;

revoke execute on function public.bell_read_purchase_opinion() from public;
revoke execute on function public.bell_read_purchase_opinion() from anon;
revoke execute on function public.bell_read_purchase_opinion() from authenticated;

drop trigger if exists trg_bell_read_purchase_opinion on public.purchase_request_manager_opinions;
create trigger trg_bell_read_purchase_opinion
  after insert on public.purchase_request_manager_opinions
  for each row
  execute function public.bell_read_purchase_opinion();

-- 今ある分の片付け（1回だけ）：申請が無い・もう承認待ちでない（pending_* 以外）・今の段で承認する人でない・今の回で回答済み
update notifications nt
   set read = true, read_at = coalesce(nt.read_at, now()), banner_dismissed = true
 where nt.read = false
   and nt.source_type = 'purchase_request:pending_approval'
   and not exists (
     select 1 from purchase_requests p
      where p.id::text = nt.reference_id
        and p.status in ('pending_leader', 'pending_manager', 'pending_board')
        and (case p.status
               when 'pending_leader'  then p.leader_id = nt.user_id
               when 'pending_manager' then nt.user_id = any(p.requested_manager_ids)
               else nt.user_id = any(p.board_approver_ids) end)
        and not (p.status = 'pending_board' and exists (
              select 1 from purchase_request_manager_opinions op
               where op.purchase_request_id = p.id and op.manager_id = nt.user_id and op.approval_round = p.approval_round)));
