-- shift_reports.status に 'returned'（差戻し）を追加
ALTER TABLE public.shift_reports
  DROP CONSTRAINT IF EXISTS shift_reports_status_check;

ALTER TABLE public.shift_reports
  ADD CONSTRAINT shift_reports_status_check
  CHECK (status IN ('pending', 'resubmitted', 'confirmed', 'cancelled', 'returned'));

-- 差戻しされた申請を申請者が再申請できるよう既存ポリシーを更新
DROP POLICY IF EXISTS "applicant_update_own_pending" ON public.shift_reports;
CREATE POLICY "applicant_update_own_pending" ON public.shift_reports
  FOR UPDATE
  USING (
    applicant_id = auth.uid()
    AND status IN ('pending', 'resubmitted', 'returned')
  )
  WITH CHECK (
    applicant_id = auth.uid()
    AND status IN ('pending', 'resubmitted')
  );
