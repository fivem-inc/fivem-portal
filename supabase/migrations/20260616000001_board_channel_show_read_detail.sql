-- board_channels に既読詳細表示フラグを追加
ALTER TABLE public.board_channels
  ADD COLUMN IF NOT EXISTS show_read_detail BOOLEAN NOT NULL DEFAULT true;
