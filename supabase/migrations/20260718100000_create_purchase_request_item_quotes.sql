-- 備品購入申請 複数商品対応 ステップ1（その2）
-- 商品ごとの相見積もり明細テーブル。1商品(purchase_request_items)に対して複数の見積もりを紐付ける。

CREATE TABLE public.purchase_request_item_quotes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_request_item_id uuid NOT NULL REFERENCES public.purchase_request_items(id) ON DELETE CASCADE,
  vendor text NOT NULL,
  unit_amount integer NOT NULL CHECK (unit_amount >= 0),
  note text,
  quote_file_path text,
  is_selected boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pr_item_quotes_item ON public.purchase_request_item_quotes(purchase_request_item_id);

-- 商品内で選択(is_selected=true)は最大1件、という排他をDBレベルでも保証する部分UNIQUEインデックス
CREATE UNIQUE INDEX uq_pr_item_quotes_one_selected
  ON public.purchase_request_item_quotes(purchase_request_item_id)
  WHERE is_selected;

CREATE OR REPLACE FUNCTION public.update_purchase_request_item_quotes_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER purchase_request_item_quotes_updated_at
  BEFORE UPDATE ON public.purchase_request_item_quotes
  FOR EACH ROW EXECUTE FUNCTION public.update_purchase_request_item_quotes_updated_at();
