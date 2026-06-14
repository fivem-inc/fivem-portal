ALTER TABLE public.board_messages
  ADD COLUMN IF NOT EXISTS deadline_type text
    CHECK (deadline_type IN ('read', 'answer', 'submit', 'approve'));

ALTER TABLE public.board_messages
  ADD COLUMN IF NOT EXISTS scheduled_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_board_messages_deadline
  ON public.board_messages(deadline) WHERE deadline IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_board_messages_scheduled_at
  ON public.board_messages(scheduled_at) WHERE scheduled_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_board_confirmations_user_id
  ON public.board_confirmations(user_id);
