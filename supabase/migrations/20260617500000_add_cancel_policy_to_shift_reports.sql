-- 申請者が自分のレコードを 'cancelled' に更新できるポリシーを追加
-- 既存の applicant_update_own_pending は WITH CHECK も status IN ('pending','resubmitted') を要求するため
-- 新ステータス 'cancelled' への変更が 403 になる問題を修正

CREATE POLICY "applicant_cancel" ON public.shift_reports
  FOR UPDATE
  USING (
    applicant_id = auth.uid()
    AND status IN ('pending', 'resubmitted', 'confirmed')
  )
  WITH CHECK (
    applicant_id = auth.uid()
    AND status = 'cancelled'
  );
