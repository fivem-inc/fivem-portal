-- ベルの「◯◯待ちです」を、申請が次の段へ進んだら自動で既読にする（2026-10-22 ユーザー確定）
--
-- きっかけ：社長のベルに、すでに受理が済んだ有休の「最終受理待ちです」が未読で残っていた。
--   ベルのお知らせは、開くか ✕ を押すまで未読のまま。ホームの黄色い知らせには「済んだら消す」作りがある（App.tsx の
--   isResolvedPending）が、ベルとナビの数字には無かった。実測（2026-10-22）：もう済んだ申請の「待ち」のお知らせが未読で 150件ほど。
--
-- 決まり：
--   ・休暇・勤務変更・残業の申請の状態（status）が変わったら、その申請の「<種類>:pending_approval」「<種類>:pending_resubmit」を
--     宛先の全員ぶん既読にする（受理・差し戻し・取消・再提出のどれでも、前の段のお知らせは役目を終えている）。
--   ・状態が同じまま受理者だけ変わったとき（休職の付け替えなど）は、前の受理者の「pending_approval」だけを既読にする。
--   🚨 次の段の人へのお知らせは、画面（lib/notifications・overtimeNotify など）が申請を書き換えた「あと」に別に入れる。
--      このトリガーは書き換えの瞬間に動くので、あとから入る新しいお知らせは消さない（2026-10-22 に全部の送る所の順番を確認）。
--      データベースの中で作るのは staff_leave_reassign だけで、それも前の受理者の分しか触らないので消えない。
--   ・既読にするだけで行は消さない（ベルの一覧の下に既読として残り、read_at から30日で自動で消える）。
--   ・スマホの通知は出さない（notifications のトリガーは INSERT のときだけ）。
--   ・備品購入申請（purchase_request:pending_approval）は対象外（流れが別・今回のきっかけと関係しない）。

create or replace function public.bell_read_resolved_pending()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prefix text := case tg_table_name
    when 'leave_requests'   then 'leave_request'
    when 'shift_reports'    then 'shift_report'
    when 'overtime_reports' then 'overtime_request'
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

drop trigger if exists trg_bell_read_resolved on public.leave_requests;
create trigger trg_bell_read_resolved
  after update of status, approver_id, approver2_id on public.leave_requests
  for each row
  when (old.status is distinct from new.status
        or old.approver_id is distinct from new.approver_id
        or old.approver2_id is distinct from new.approver2_id)
  execute function public.bell_read_resolved_pending();

drop trigger if exists trg_bell_read_resolved on public.shift_reports;
create trigger trg_bell_read_resolved
  after update of status, reviewer_id on public.shift_reports
  for each row
  when (old.status is distinct from new.status or old.reviewer_id is distinct from new.reviewer_id)
  execute function public.bell_read_resolved_pending();

drop trigger if exists trg_bell_read_resolved on public.overtime_reports;
create trigger trg_bell_read_resolved
  after update of status, reviewer_id on public.overtime_reports
  for each row
  when (old.status is distinct from new.status or old.reviewer_id is distinct from new.reviewer_id)
  execute function public.bell_read_resolved_pending();

-- 今ある分の片付け（1回だけ）：もう済んだ申請・申請が無いもの・今の受理者でない人あての「待ち」を既読にする。
-- 🚨 まだ途中の申請（休暇の受理の途中・残業の requested／reported・勤務変更の pending／resubmitted）で、今の受理者あてのものは残す。
--    休暇は受理者が段ごとに違うので、途中の申請には触らない（済んだもの＝approved／rejected／cancelled と申請が無いものだけ）。
update notifications nt
   set read = true, read_at = coalesce(nt.read_at, now()), banner_dismissed = true
 where nt.read = false
   and (
     (nt.source_type = 'leave_request:pending_approval' and not exists (
        select 1 from leave_requests l where l.id::text = nt.reference_id and l.status not in ('approved', 'rejected', 'cancelled')))
  or (nt.source_type = 'leave_request:pending_resubmit' and not exists (
        select 1 from leave_requests l where l.id::text = nt.reference_id and l.status = 'rejected'))
  or (nt.source_type = 'shift_report:pending_approval' and not exists (
        select 1 from shift_reports s where s.id::text = nt.reference_id and s.status in ('pending', 'resubmitted') and s.reviewer_id = nt.user_id))
  or (nt.source_type = 'shift_report:pending_resubmit' and not exists (
        select 1 from shift_reports s where s.id::text = nt.reference_id and s.status = 'returned'))
  or (nt.source_type = 'overtime_request:pending_approval' and not exists (
        select 1 from overtime_reports o where o.id::text = nt.reference_id and o.status in ('requested', 'reported') and o.reviewer_id = nt.user_id))
  or (nt.source_type = 'overtime_request:pending_resubmit' and not exists (
        select 1 from overtime_reports o where o.id::text = nt.reference_id and o.status = 'returned'))
   );
