-- 社内連絡板テーブル

-- チャンネル（グループ or 個人DM）
CREATE TABLE IF NOT EXISTS public.board_channels (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type       TEXT NOT NULL CHECK (type IN ('group', 'dm')),
  name       TEXT,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.board_channels ENABLE ROW LEVEL SECURITY;

-- チャンネルメンバー
CREATE TABLE IF NOT EXISTS public.board_channel_members (
  channel_id UUID NOT NULL REFERENCES public.board_channels(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  PRIMARY KEY (channel_id, user_id)
);
ALTER TABLE public.board_channel_members ENABLE ROW LEVEL SECURITY;

-- メッセージ（parent_id NULL = スレッド親、非NULL = リプライ）
CREATE TABLE IF NOT EXISTS public.board_messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id UUID NOT NULL REFERENCES public.board_channels(id) ON DELETE CASCADE,
  parent_id  UUID REFERENCES public.board_messages(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id),
  body       TEXT NOT NULL,
  edited_at  TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE public.board_messages ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_board_messages_channel ON public.board_messages (channel_id, created_at);
CREATE INDEX IF NOT EXISTS idx_board_messages_parent  ON public.board_messages (parent_id);

-- チャンネルごとの最終既読時刻（未読バッジ用）
CREATE TABLE IF NOT EXISTS public.board_channel_last_seen (
  channel_id  UUID NOT NULL REFERENCES public.board_channels(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  last_seen_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);
ALTER TABLE public.board_channel_last_seen ENABLE ROW LEVEL SECURITY;

-- メッセージ既読（既読人数表示用）
CREATE TABLE IF NOT EXISTS public.board_reads (
  message_id UUID NOT NULL REFERENCES public.board_messages(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  read_at    TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);
ALTER TABLE public.board_reads ENABLE ROW LEVEL SECURITY;

-- ────────────────────────────────────────────────────────────────
-- RLS ポリシー
-- ────────────────────────────────────────────────────────────────

-- board_channels: 自分がメンバーのチャンネルのみ参照可
CREATE POLICY "board_channels_select" ON public.board_channels FOR SELECT TO authenticated
  USING (
    id IN (SELECT channel_id FROM public.board_channel_members WHERE user_id = auth.uid())
    OR (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );
CREATE POLICY "board_channels_insert" ON public.board_channels FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());
CREATE POLICY "board_channels_update" ON public.board_channels FOR UPDATE TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
CREATE POLICY "board_channels_delete" ON public.board_channels FOR DELETE TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- board_channel_members: 全認証ユーザー参照可（内部ツールなので問題なし）
CREATE POLICY "board_members_select" ON public.board_channel_members FOR SELECT TO authenticated USING (true);
CREATE POLICY "board_members_insert" ON public.board_channel_members FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "board_members_delete" ON public.board_channel_members FOR DELETE TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' OR user_id = auth.uid());

-- board_messages: チャンネルメンバーのみ参照・投稿可
CREATE POLICY "board_messages_select" ON public.board_messages FOR SELECT TO authenticated
  USING (
    channel_id IN (SELECT channel_id FROM public.board_channel_members WHERE user_id = auth.uid())
    OR (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );
CREATE POLICY "board_messages_insert" ON public.board_messages FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND (
      channel_id IN (SELECT channel_id FROM public.board_channel_members WHERE user_id = auth.uid())
      OR (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    )
  );
CREATE POLICY "board_messages_update" ON public.board_messages FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
CREATE POLICY "board_messages_delete" ON public.board_messages FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- board_channel_last_seen: 自分の記録のみ
CREATE POLICY "board_last_seen_all" ON public.board_channel_last_seen FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- board_reads: 全チャンネルメンバーが参照可（既読人数表示のため）・書き込みは自分のみ
CREATE POLICY "board_reads_select" ON public.board_reads FOR SELECT TO authenticated USING (true);
CREATE POLICY "board_reads_insert" ON public.board_reads FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
CREATE POLICY "board_reads_delete" ON public.board_reads FOR DELETE TO authenticated
  USING (user_id = auth.uid());
