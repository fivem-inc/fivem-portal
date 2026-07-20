-- 勤務変更報告に「管理者修正」を追加。
-- 1) shift_report_history に change_kind / change_reason / changes を追加（既存はsnapshot+change_summaryのみ）
-- 2) shift_reports に管理者UPDATEポリシーが無い（applicant/reviewer限定）ため app_metadata 形式で追記
-- 3) 本体update＋履歴insertを原子的に行うRPC
-- ※既存データは壊さない。change_kind は nullable＋ベストエフォート補完。

alter table shift_report_history
  add column if not exists change_kind text,
  add column if not exists change_reason text,
  add column if not exists changes jsonb;

-- 既存履歴のchange_summaryからバッジ種別をベストエフォートで補完（不明はnull＝バッジ無しでテキスト表示）
update shift_report_history set change_kind = 'rejected'  where change_kind is null and change_summary like '%差戻%';
update shift_report_history set change_kind = 'resubmit'  where change_kind is null and (change_summary like '%再報告%' or change_summary like '%実績報告%' or change_summary like '%再提出%');
update shift_report_history set change_kind = 'approved'  where change_kind is null and change_summary like '%受理%';
update shift_report_history set change_kind = 'cancelled' where change_kind is null and change_summary like '%取消%';

-- 管理者は勤務変更報告を更新できる（★app_metadata 形式厳守。旧 (auth.jwt()->>'role') は 'authenticated' が返り42501全滅）
drop policy if exists "shift_reports_admin_update" on shift_reports;
create policy "shift_reports_admin_update" on shift_reports
  for update using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- 管理者が勤務変更報告の内容を直接修正する。本体update＋履歴insertを1トランザクションで。
create or replace function admin_edit_shift_report(
  p_id uuid,
  p_application_types text[],
  p_work_date date,
  p_actual_location text,
  p_actual_start time,
  p_actual_end time,
  p_actual_outing_start time,
  p_actual_outing_end time,
  p_break_minutes int,
  p_labor_minutes int,
  p_reason text,
  p_changes jsonb,
  p_change_summary text,
  p_change_reason text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_snapshot jsonb;
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') <> 'admin' then
    raise exception 'permission denied: admin only' using errcode = '42501';
  end if;

  select to_jsonb(sr.*) into v_snapshot from shift_reports sr where sr.id = p_id;
  if v_snapshot is null then
    raise exception 'shift_report not found: %', p_id using errcode = 'P0002';
  end if;

  update shift_reports set
    application_types    = p_application_types,
    application_type     = coalesce(p_application_types[1], application_type),
    work_date            = p_work_date,
    actual_location      = p_actual_location,
    actual_start         = p_actual_start,
    actual_end           = p_actual_end,
    actual_outing_start  = p_actual_outing_start,
    actual_outing_end    = p_actual_outing_end,
    break_minutes        = p_break_minutes,
    labor_minutes        = p_labor_minutes,
    reason               = p_reason,
    updated_at           = now()
  where id = p_id;

  insert into shift_report_history
    (report_id, changed_by, change_kind, change_summary, change_reason, changes, snapshot)
  values
    (p_id, auth.uid(), 'admin_edit', p_change_summary, p_change_reason, p_changes, v_snapshot);
end;
$$;

grant execute on function admin_edit_shift_report(
  uuid, text[], date, text, time, time, time, time, int, int, text, jsonb, text, text
) to authenticated;
