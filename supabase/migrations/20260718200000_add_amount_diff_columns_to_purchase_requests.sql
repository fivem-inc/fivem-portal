-- 備品購入申請 複数商品対応 ステップ1（その3）
-- 金額欄を手動上書きした結果、商品明細の合計（items_subtotal）と本体amountが乖離した場合に、
-- 送信自体はブロックしないが、乖離の事実を必ず記録し承認者・履歴・CSVで可視化するための列を追加する。

ALTER TABLE public.purchase_requests
  ADD COLUMN amount_diff_reason text,
  ADD COLUMN items_subtotal integer;

ALTER TABLE public.purchase_requests
  ADD COLUMN amount_diff_flag boolean GENERATED ALWAYS AS (
    items_subtotal IS NOT NULL AND items_subtotal <> amount
  ) STORED;
