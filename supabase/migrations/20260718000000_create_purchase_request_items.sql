-- 備品購入申請 複数商品対応 ステップ1（その1）
-- 1申請で複数商品をまとめて申請できるようにするための明細テーブル。
-- 本体purchase_requestsのitem_name/quantity/amount/store_name/quotes列は
-- 後方互換のフォールバック表示用にそのまま残す（既存データ・既存画面を壊さないため）。

CREATE TABLE public.purchase_request_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_request_id uuid NOT NULL REFERENCES public.purchase_requests(id) ON DELETE CASCADE,
  sort_order integer NOT NULL DEFAULT 0,
  item_name text NOT NULL,
  quantity integer,
  amount integer NOT NULL CHECK (amount >= 0),
  amount_manually_overridden boolean NOT NULL DEFAULT false,
  store_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_purchase_request_items_request ON public.purchase_request_items(purchase_request_id);

CREATE OR REPLACE FUNCTION public.update_purchase_request_items_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER purchase_request_items_updated_at
  BEFORE UPDATE ON public.purchase_request_items
  FOR EACH ROW EXECUTE FUNCTION public.update_purchase_request_items_updated_at();
