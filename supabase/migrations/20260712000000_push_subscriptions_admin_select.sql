-- 管理者がユーザー管理画面で「誰がプッシュ通知を許可しているか」を
-- 確認できるよう、push_subscriptionsに管理者の閲覧のみ許可を追加
-- （既存の「本人のみ全操作可」ポリシーはそのまま。編集・削除は本人のみ）
CREATE POLICY "管理者は閲覧可"
  ON push_subscriptions
  FOR SELECT
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
