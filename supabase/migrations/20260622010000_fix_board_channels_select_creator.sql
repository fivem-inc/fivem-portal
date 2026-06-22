-- DM/チャンネル作成時の 403 修正
--
-- 原因: クライアントは board_channels への INSERT を ?select=* 付きで実行するため、
--       PostgREST は挿入直後にその行を SELECT で読み返す。しかしメンバー登録
--       (board_channel_members への INSERT) は別クエリで後から行われるため、
--       読み返しの時点で作成者はまだメンバーではなく、SELECT ポリシーに弾かれて 403 になる。
--       管理者は SELECT ポリシーに `OR role=admin` の抜け道があるため作成できていた。
--
-- 修正: SELECT ポリシーに「自分が作成したチャンネルは読める」を追加する。

DROP POLICY IF EXISTS board_channels_select ON public.board_channels;
CREATE POLICY board_channels_select ON public.board_channels FOR SELECT TO authenticated
USING (
  id IN (SELECT channel_id FROM public.board_channel_members WHERE user_id = auth.uid())
  OR created_by = auth.uid()
  OR (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);
