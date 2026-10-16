-- 修正依頼を、元の申請を受理・確認する上長にも見えるようにする（2026-10-16 ユーザー確定）
-- 上長の「受理待ち」（休暇）・「確認待ち」（残業）のカードに「📩 修正依頼あり（対応待ち）」の帯を出すため（components/CorrectionNotice）。
-- それまで見えたのは管理者と、依頼を送った本人だけだった。
-- ・休暇：その申請の1人目・2人目の受理者（approver_id / approver2_id）と社長（leave_requests を読める条件と同じ）
-- ・残業：その申請の確認者（reviewer_id）
-- ・勤務変更：上長の画面に出さないので足さない（管理画面は管理者なので今までどおり見える）
-- 🚨 読むだけ。書き込み（対応済み・対応不可）は今までどおり管理者だけ

begin;

drop policy if exists correction_requests_approver_select on public.correction_requests;
create policy correction_requests_approver_select on public.correction_requests
  for select to authenticated
  using (
    (target_type = 'leave' and exists (
      select 1 from public.leave_requests l
       where l.id = correction_requests.target_id
         and (l.approver_id = auth.uid() or l.approver2_id = auth.uid() or acts_as_is('president'))
    ))
    or
    (target_type = 'overtime' and exists (
      select 1 from public.overtime_reports o
       where o.id = correction_requests.target_id
         and o.reviewer_id = auth.uid()
    ))
  );

commit;
