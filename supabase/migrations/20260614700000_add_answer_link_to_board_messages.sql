ALTER TABLE public.board_messages
  ADD COLUMN IF NOT EXISTS answer_link text;
