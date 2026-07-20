-- 残業（overtime）に「管理者修正」を追加。
-- 1) overtime_report_history に change_kind / change_reason / changes を追加
-- 2) 本体update＋時間帯入替＋履歴insert を原子的に行うRPC（entry_type='manual' 限定。leave_auto行はガード）
-- ※既存データは壊さない。

alter table overtime_report_history
  add column if not exists change_kind text,
  add column if not exists change_reason text,
  add column if not exists changes jsonb;

update overtime_report_history set change_kind = 'rejected'  where change_kind is null and change_summary like '%差戻%';
update overtime_report_history set change_kind = 'resubmit'  where change_kind is null and (change_summary like '%再提出%' or change_summary like '%実績報告%');
update overtime_report_history set change_kind = 'approved'  where change_kind is null and change_summary like '%受理%';
update overtime_report_history set change_kind = 'cancelled' where change_kind is null and change_summary like '%取消%';

-- 管理者が残業レコードの内容を直接修正する。休憩・実労働・差分・法定警告は呼び出し側で breakCalc により再計算して渡す。
-- 時間帯（segments）は指定phaseを全入れ替え。すべて1トランザクション。
create or replace function admin_edit_overtime_report(
  p_id uuid,
  p_work_date date,
  p_break_minutes int,
  p_break_manual boolean,
  p_labor_minutes int,
  p_diff_minutes int,
  p_legal_warning boolean,
  p_reason text,
  p_location text,
  p_phase text,
  p_segments jsonb,   -- [{ "seg_no":1, "start_min":600, "end_min":1040 }, ...]
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
  v_entry_type text;
  v_seg jsonb;
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') <> 'admin' then
    raise exception 'permission denied: admin only' using errcode = '42501';
  end if;

  select to_jsonb(r.*), r.entry_type into v_snapshot, v_entry_type
  from overtime_reports r where r.id = p_id;
  if v_snapshot is null then
    raise exception 'overtime_report not found: %', p_id using errcode = 'P0002';
  end if;
  -- 自動計上行（調整休由来）はトリガー管理のため直接修正を禁止
  if v_entry_type <> 'manual' then
    raise exception 'leave_auto rows cannot be edited directly' using errcode = 'P0001';
  end if;
  if p_phase not in ('planned','actual') then
    raise exception 'invalid phase: %', p_phase using errcode = '22023';
  end if;

  update overtime_reports set
    work_date      = p_work_date,
    pay_period_start = calc_pay_period_start(p_work_date),
    break_minutes  = p_break_minutes,
    break_manual   = p_break_manual,
    labor_minutes  = p_labor_minutes,
    diff_minutes   = p_diff_minutes,
    legal_warning  = p_legal_warning,
    reason         = p_reason,
    location       = p_location,
    updated_at     = now()
  where id = p_id;

  -- 指定phaseの時間帯を全入れ替え
  delete from overtime_report_segments where report_id = p_id and phase = p_phase;
  for v_seg in select * from jsonb_array_elements(coalesce(p_segments, '[]'::jsonb))
  loop
    insert into overtime_report_segments (report_id, phase, seg_no, start_min, end_min)
    values (
      p_id, p_phase,
      (v_seg->>'seg_no')::int,
      (v_seg->>'start_min')::int,
      (v_seg->>'end_min')::int
    );
  end loop;

  insert into overtime_report_history
    (report_id, changed_by, change_kind, change_summary, change_reason, changes, snapshot)
  values
    (p_id, auth.uid(), 'admin_edit', p_change_summary, p_change_reason, p_changes, v_snapshot);
end;
$$;

grant execute on function admin_edit_overtime_report(
  uuid, date, int, boolean, int, int, boolean, text, text, text, jsonb, jsonb, text, text
) to authenticated;
