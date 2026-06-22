-- 出張報告の削除ができない問題の修正
--
-- 原因: business_trip_reports に DELETE ポリシーが1つも無かった。
--       Supabase RLS は「許可ポリシーの無い操作は全拒否」のため、
--       DELETE は 0 行削除で成功扱い（エラーなし）→ 再取得で行が残り「消えない」ように見えていた。
--
-- 修正: 管理者のみ全件削除できる DELETE ポリシーを追加（本人による削除は不可）。

CREATE POLICY "Admins can delete all reports" ON public.business_trip_reports
  FOR DELETE TO authenticated
  USING (((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text);
