-- 勤務変更申請の種別に「勤務地変更」(location_change)を追加
ALTER TABLE shift_reports
  DROP CONSTRAINT IF EXISTS shift_reports_application_type_check;

ALTER TABLE shift_reports
  ADD CONSTRAINT shift_reports_application_type_check
  CHECK (application_type IN ('overtime','holiday_work','early_leave','tardiness','absence','early_start','location_change'));
