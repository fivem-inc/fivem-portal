-- 自己受理／残業ゼロ（差分0）で status='confirmed' 直行のとき、本人による segments の
-- 書き込み（insert/delete）が segments_write_own の with check に弾かれる不具合を修正。
-- 本人が自分で確定したレコード（confirmed_by = auth.uid()）は書き込みを許可する。
-- ※他者受理（reviewer 承認）は Edge Function=service_role が書くため本ポリシーの対象外。
drop policy if exists "segments_write_own" on overtime_report_segments;
create policy "segments_write_own" on overtime_report_segments
  for all using (
    exists (
      select 1 from overtime_reports r
      where r.id = report_id
        and r.applicant_id = auth.uid()
        and (
          r.status in ('requested','request_confirmed','reported','returned')
          or (r.status = 'confirmed' and r.confirmed_by = auth.uid())
        )
    )
  )
  with check (
    exists (
      select 1 from overtime_reports r
      where r.id = report_id
        and r.applicant_id = auth.uid()
        and (
          r.status in ('requested','request_confirmed','reported','returned')
          or (r.status = 'confirmed' and r.confirmed_by = auth.uid())
        )
    )
  );
