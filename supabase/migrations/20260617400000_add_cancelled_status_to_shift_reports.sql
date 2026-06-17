-- shift_reports.status に 'cancelled' を追加
-- 既存の CHECK 制約を更新する

ALTER TABLE public.shift_reports
  DROP CONSTRAINT IF EXISTS shift_reports_status_check;

ALTER TABLE public.shift_reports
  ADD CONSTRAINT shift_reports_status_check
  CHECK (status IN ('pending', 'resubmitted', 'confirmed', 'cancelled'));
