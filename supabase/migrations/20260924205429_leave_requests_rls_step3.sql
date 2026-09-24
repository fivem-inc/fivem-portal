-- ============================================================
-- 休暇の穴 第3段（2026-09-24）：本人が「受理済み」の休暇を作れない／自分の申請を自分で受理できないようにする
-- ============================================================
-- 経緯：アーカイブ (39)。第1段・第2段（20260912122255 / 20260912122836）で
--   有給奨励日の回答を専用処理 answer_encouragement_day（SECURITY DEFINER）へ移した。
--   ここで最後に表の許可を締める。
--
-- 締める前に確かめた入口（2026-09-24 実測）：
--   ・本人の申請（LeaveRequest.tsx）／残業調整の提案を受けて調整休（OvertimeProposalResponse.tsx）
--       … どちらも user_id=本人・status='pending' で insert → 締めた後も通る
--   ・本人の取り消し・編集・有給奨励日の回答 … cancel_own_leave / edit_own_leave /
--       answer_encouragement_day（いずれも SECURITY DEFINER）→ 表の許可の影響を受けない
--   ・承認（LeaveApprovals.tsx）… 承認者が「他人の申請」を update → 締めた後も通る
--   ・管理画面が他人の分を受理済みで作る2か所（LeaveRequestsTab）… 別の許可
--       admin_insert_leave_requests（is_org_wide()＝社長・管理者の2名）で通る。ここでは触らない
--   ・自分で自分を承認した行（approver_id か approver2_id が本人）… 本番で 0件
--
-- 取り消し版で確かめたこと（本番・なりすまし）：
--   一般：本人 pending＝通る／本人 approved＝弾く／承認者に自分＝弾く／他人の分＝弾く／
--         他人の申請を承認＝通る／自分の申請を承認＝弾く
--   管理者：他人の分を approved で作る＝通る／更新＝通る
--
-- 何度実行しても同じ結果

-- 1) 本人の作成は「申請中」だけ。承認者に自分を入れることもできない
drop policy if exists insert_own on public.leave_requests;
create policy insert_own on public.leave_requests
  for insert to public
  with check (
    auth.uid() = user_id
    and status = 'pending'
    and approver_id  is distinct from auth.uid()
    and approver2_id is distinct from auth.uid()
  );

-- 2) 更新：書き換えた後の行にも条件をかける（これまで WITH CHECK が無く USING が流用されていた）。
--    承認者が触れるのは「他人の申請」だけ。自分の申請を承認者として書き換えることはできない。
--    管理者と社長は今までどおり（USING と同じ）
drop policy if exists update_admin on public.leave_requests;
create policy update_admin on public.leave_requests
  for update to public
  using (
    (approver_id = auth.uid()) or (approver2_id = auth.uid()) or is_admin() or acts_as_is('president'::text)
  )
  with check (
    is_admin()
    or acts_as_is('president'::text)
    or (
      ((approver_id = auth.uid()) or (approver2_id = auth.uid()))
      and user_id is distinct from auth.uid()
    )
  );
