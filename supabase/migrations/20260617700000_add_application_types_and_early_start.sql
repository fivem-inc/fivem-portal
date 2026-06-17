-- 早出(early_start)を application_type の CHECK 制約に追加
ALTER TABLE shift_reports
  DROP CONSTRAINT IF EXISTS shift_reports_application_type_check;

ALTER TABLE shift_reports
  ADD CONSTRAINT shift_reports_application_type_check
  CHECK (application_type IN ('overtime','holiday_work','early_leave','tardiness','absence','early_start'));

-- 複数種別を格納する配列カラムを追加
ALTER TABLE shift_reports
  ADD COLUMN IF NOT EXISTS application_types text[] NOT NULL DEFAULT '{}';

-- 既存レコードを配列に移行
UPDATE shift_reports
  SET application_types = ARRAY[application_type::text]
  WHERE application_types = '{}';
