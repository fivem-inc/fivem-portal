ALTER TABLE public.board_messages
  ADD COLUMN IF NOT EXISTS title text;
