ALTER TABLE public.board_confirmations
  ADD COLUMN IF NOT EXISTS comment text;
