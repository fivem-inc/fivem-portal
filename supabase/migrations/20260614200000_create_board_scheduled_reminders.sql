CREATE TABLE IF NOT EXISTS public.board_scheduled_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by uuid NOT NULL REFERENCES auth.users(id),
  channel_id uuid REFERENCES public.board_channels(id) ON DELETE CASCADE,
  day_of_month int NOT NULL CHECK (day_of_month BETWEEN 1 AND 31),
  title text NOT NULL,
  body text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.board_scheduled_reminders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "管理者のみ操作可"
  ON public.board_scheduled_reminders
  FOR ALL
  TO authenticated
  USING (true)
  WITH CHECK (true);
