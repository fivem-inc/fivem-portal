-- 連絡板リニューアル: 受信ボックス・送信トレイ対応

-- 1. board_messages に新カラム追加
ALTER TABLE public.board_messages
  ADD COLUMN IF NOT EXISTS subject        TEXT,
  ADD COLUMN IF NOT EXISTS comment_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS status         TEXT NOT NULL DEFAULT 'sent';

-- 2. channel_id を nullable に（受信ボックス型メッセージはチャンネル不要）
ALTER TABLE public.board_messages ALTER COLUMN channel_id DROP NOT NULL;

-- 3. board_message_recipients を先に作る（RLSポリシーが参照するため）
CREATE TABLE IF NOT EXISTS public.board_message_recipients (
  message_id UUID NOT NULL REFERENCES public.board_messages(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  archived   BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (message_id, user_id)
);
ALTER TABLE public.board_message_recipients ENABLE ROW LEVEL SECURITY;

CREATE POLICY "board_recipients_select_own" ON public.board_message_recipients
  FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "board_recipients_select_admin" ON public.board_message_recipients
  FOR SELECT TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

CREATE POLICY "board_recipients_select_sender" ON public.board_message_recipients
  FOR SELECT TO authenticated
  USING (
    message_id IN (SELECT id FROM public.board_messages WHERE user_id = auth.uid())
  );

CREATE POLICY "board_recipients_insert" ON public.board_message_recipients
  FOR INSERT TO authenticated
  WITH CHECK (true);

CREATE POLICY "board_recipients_update_own" ON public.board_message_recipients
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- 4. board_messages RLS 更新（board_message_recipients が存在する状態で実行）
DROP POLICY IF EXISTS "board_messages_select" ON public.board_messages;
DROP POLICY IF EXISTS "board_messages_insert" ON public.board_messages;

CREATE POLICY "board_messages_select" ON public.board_messages FOR SELECT TO authenticated
  USING (
    -- 従来: チャンネルメンバー or 管理者
    (channel_id IS NOT NULL AND (
      channel_id IN (SELECT channel_id FROM public.board_channel_members WHERE user_id = auth.uid())
      OR (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    ))
    -- 新: 受信ボックス - 送信者または受信者
    OR (channel_id IS NULL AND (
      user_id = auth.uid()
      OR id IN (SELECT message_id FROM public.board_message_recipients WHERE user_id = auth.uid())
      OR (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    ))
  );

CREATE POLICY "board_messages_insert" ON public.board_messages FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND (
      -- 従来: チャンネルメンバー or 管理者
      (channel_id IS NOT NULL AND (
        channel_id IN (SELECT channel_id FROM public.board_channel_members WHERE user_id = auth.uid())
        OR (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
      ))
      -- 新: 受信ボックス型（channel_id = NULL）は誰でも送信可
      OR channel_id IS NULL
    )
  );

-- 5. board_favorites 新設
CREATE TABLE IF NOT EXISTS public.board_favorites (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  message_id UUID NOT NULL REFERENCES public.board_messages(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, message_id)
);
ALTER TABLE public.board_favorites ENABLE ROW LEVEL SECURITY;

CREATE POLICY "board_favorites_all" ON public.board_favorites
  FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- 6. インデックス
CREATE INDEX IF NOT EXISTS idx_board_msg_recipients_user ON public.board_message_recipients (user_id);
CREATE INDEX IF NOT EXISTS idx_board_msg_recipients_msg  ON public.board_message_recipients (message_id);
CREATE INDEX IF NOT EXISTS idx_board_messages_sender     ON public.board_messages (user_id, created_at);
