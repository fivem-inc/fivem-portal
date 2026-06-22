-- board_channels.created_by をクライアント送信値に依存せず、常にDBサーバー側の auth.uid() で強制上書きする
-- 目的: 複数タブ・セッション競合等でクライアントの user.id とJWTのsubがズレた場合でも
--       INSERT自体は必ず成功させる（RLSの created_by = auth.uid() チェックは
--       BEFORE INSERTトリガーで上書きされた後の値で評価されるため、常に一致する）

CREATE OR REPLACE FUNCTION public.set_board_channels_created_by()
RETURNS TRIGGER AS $$
BEGIN
  NEW.created_by := auth.uid();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_set_board_channels_created_by ON public.board_channels;
CREATE TRIGGER trg_set_board_channels_created_by
  BEFORE INSERT ON public.board_channels
  FOR EACH ROW
  EXECUTE FUNCTION public.set_board_channels_created_by();
