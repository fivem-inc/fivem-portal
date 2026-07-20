-- ========================================
-- 修正依頼 第2弾のDB変更
-- 1) 勤務変更：本人取消(applicant_cancel)から confirmed を外し returned を許可（受理済み取消は依頼へ）
-- 2) 休暇：本人の編集・取消を pending 限定で行う RPC（承認共用の緩い update_admin は触らない）
-- 3) 申請が取消(cancelled)されたら、その申請への open 依頼を自動で対応済みにし本人へ通知
-- 追加のみ／既存データ無傷。
-- ========================================

-- 1) 勤務変更 本人取消の範囲を「未承認のみ」に（受理済み confirmed は本人不可＝取消依頼へ）
drop policy if exists "applicant_cancel" on shift_reports;
create policy "applicant_cancel" on shift_reports for update
  using  (applicant_id = auth.uid() and status in ('pending','resubmitted','returned'))
  with check (applicant_id = auth.uid() and status = 'cancelled');

-- 2) 休暇：本人が pending の自分の申請を編集（承認前のみ。SECURITY DEFINERで確実に status で縛る）
create or replace function edit_own_leave(
  p_id uuid,
  p_leave_type text,
  p_leave_type_other text,
  p_leave_dates text,
  p_leave_locations text,
  p_purpose text,
  p_reason text,
  p_start_date date,
  p_end_date date
) returns void
language plpgsql security definer set search_path = public
as $$
begin
  update leave_requests set
    leave_type       = p_leave_type,
    leave_type_other = p_leave_type_other,
    leave_dates      = p_leave_dates,
    leave_locations  = p_leave_locations,
    purpose          = p_purpose,
    reason           = p_reason,
    start_date       = p_start_date,
    end_date         = p_end_date
  where id = p_id and user_id = auth.uid() and status = 'pending';
  if not found then
    raise exception '編集できません（承認済みか対象外です）' using errcode = 'P0001';
  end if;
end;
$$;
grant execute on function edit_own_leave(uuid, text, text, text, text, text, text, date, date) to authenticated;

-- 休暇：本人が pending / 差戻し(rejected) の自分の申請を取り消す（受理済みは不可＝取消依頼へ）
create or replace function cancel_own_leave(p_id uuid) returns void
language plpgsql security definer set search_path = public
as $$
begin
  update leave_requests set status = 'cancelled'
  where id = p_id and user_id = auth.uid() and status in ('pending','rejected');
  if not found then
    raise exception '取消できません（承認済みか対象外です）' using errcode = 'P0001';
  end if;
end;
$$;
grant execute on function cancel_own_leave(uuid) to authenticated;

-- 3) 申請が取消(cancelled)されたら、その申請への open 依頼を自動で resolved にし、本人へ通知
--    ＝管理者が「取り消して対応」したときも、本人が取り消したときも、宙に浮いた依頼を残さない
create or replace function resolve_corrections_on_cancel() returns trigger
language plpgsql security definer set search_path = public
as $$
declare r record;
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    for r in
      select id, requester_id from correction_requests
      where target_type = tg_argv[0] and target_id = new.id and status = 'open'
    loop
      update correction_requests set
        status = 'resolved', resolved_at = now(),
        admin_reply = coalesce(admin_reply, '対象の申請が取り消されました')
      where id = r.id;
      insert into notifications (user_id, message, sub_message, source_type, reference_id, event_key, read)
      values (r.requester_id, '依頼に対応しました', '対象の申請を取り消しました',
              'correction_request', r.id, 'correction:resolved', false);
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_leave_cancel_resolve on leave_requests;
create trigger trg_leave_cancel_resolve after update on leave_requests
  for each row execute function resolve_corrections_on_cancel('leave');
drop trigger if exists trg_shift_cancel_resolve on shift_reports;
create trigger trg_shift_cancel_resolve after update on shift_reports
  for each row execute function resolve_corrections_on_cancel('shift');
drop trigger if exists trg_overtime_cancel_resolve on overtime_reports;
create trigger trg_overtime_cancel_resolve after update on overtime_reports
  for each row execute function resolve_corrections_on_cancel('overtime');
