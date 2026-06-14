ALTER TABLE public.board_messages
  ADD COLUMN IF NOT EXISTS answer_prompt text,
  ADD COLUMN IF NOT EXISTS answer_location text;
