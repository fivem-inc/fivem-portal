-- 残業・時間管理：種別(application_types)追加＋GCal同期対応＋履歴表示バグ修正用FK
-- 1) application_types text[] を追加（勤務変更 shift_reports と同方式・複数選択可）
-- 2) profiles への named FK を追加（PostgREST embed 用。既存FKは auth.users 向きのため
--    `profiles!overtime_reports_applicant_id_fkey` の embed が解決できず本人履歴が常に0件になるバグの修正）
-- 3) admin_edit_overtime_report に p_application_types を追加（管理者修正で種別も直せるように）
-- ※既存データは壊さない。残業機能は未公開のためバックフィル不要（既存行は '{}' のまま）。

-- 1) 種別カラム（許容値: 残業/早出/遅刻/早退/休日出勤/勤務地変更/調整遅出/調整早退）
alter table overtime_reports
  add column if not exists application_types text[] not null default '{}';

alter table overtime_reports
  add constraint overtime_reports_application_types_check
  check (application_types <@ array[
    'overtime','early_start','tardiness','early_leave',
    'holiday_work','location_change','late_start_adj','early_end_adj'
  ]::text[]);

-- 2) profiles への named FK（embed 解決用。profiles.id = auth.users.id の1:1なので実質制約は増えない）
alter table overtime_reports
  add constraint overtime_reports_applicant_profiles_fkey
  foreign key (applicant_id) references profiles(id) on delete cascade;

alter table overtime_reports
  add constraint overtime_reports_reviewer_profiles_fkey
  foreign key (reviewer_id) references profiles(id);

-- 3) 管理者修正RPCに種別引数を追加（引数追加はオーバーロードを生むため旧シグネチャを先にdrop）
drop function if exists admin_edit_overtime_report(
  uuid, date, int, boolean, int, int, boolean, text, text, text, jsonb, jsonb, text, text
);

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
  p_change_reason text,
  p_application_types text[] default null  -- null なら変更しない
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
    application_types = coalesce(p_application_types, application_types),
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
  uuid, date, int, boolean, int, int, boolean, text, text, text, jsonb, jsonb, text, text, text[]
) to authenticated;
