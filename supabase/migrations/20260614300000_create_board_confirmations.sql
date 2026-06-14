CREATE TABLE IF NOT EXISTS public.board_confirmations (
  message_id uuid NOT NULL REFERENCES public.board_messages(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  confirmed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);

ALTER TABLE public.board_confirmations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "board_confirmations_select" ON public.board_confirmations
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "board_confirmations_insert" ON public.board_confirmations
  FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

ALTER TABLE public.board_messages ADD COLUMN IF NOT EXISTS requires_confirmation boolean NOT NULL DEFAULT false;
