-- 受信者が同じメッセージの他の受信者も閲覧できるようにする
-- （既読状況・宛先表示で全員分が見えるようにするため）
CREATE POLICY "board_recipients_select_peer" ON public.board_message_recipients
  FOR SELECT TO authenticated
  USING (
    message_id IN (
      SELECT message_id FROM public.board_message_recipients WHERE user_id = auth.uid()
    )
  );
