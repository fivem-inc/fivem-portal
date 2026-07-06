-- 備品購入申請 複数商品対応 ステップ1（その5）
-- 商品明細1件に対して、複数の見積もりの中からどれを採用するかを選択するRPC。
-- SECURITY INVOKERでRLSに従う方針は既存のsubmit_board_opinion等と同じ。

CREATE OR REPLACE FUNCTION public.select_purchase_item_quote(
  p_item_id uuid,
  p_quote_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_item public.purchase_request_items%ROWTYPE;
  v_pr public.purchase_requests%ROWTYPE;
  v_unit_amount integer;
BEGIN
  -- 1. 対象item行をFOR UPDATEでロックしつつ、所有者チェック・ステータスチェックを行う
  SELECT pri.* INTO v_item
    FROM public.purchase_request_items pri
    WHERE pri.id = p_item_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '対象の商品明細が見つかりません';
  END IF;

  SELECT pr.* INTO v_pr
    FROM public.purchase_requests pr
    WHERE pr.id = v_item.purchase_request_id;

  IF NOT FOUND OR v_pr.user_id != auth.uid()
     OR v_pr.status NOT IN ('pending_leader', 'pending_manager', 'pending_board', 'self_judgment_shared', 'returned') THEN
    RAISE EXCEPTION 'この商品明細の見積もりを選択する権限がありません';
  END IF;

  -- 2. 対象item配下の全quote行のis_selectedをfalseにする
  UPDATE public.purchase_request_item_quotes
    SET is_selected = false
    WHERE purchase_request_item_id = p_item_id;

  -- 3. p_quote_idがNULLでなければ、その行のis_selectedをtrueにする
  IF p_quote_id IS NOT NULL THEN
    UPDATE public.purchase_request_item_quotes
      SET is_selected = true
      WHERE id = p_quote_id
        AND purchase_request_item_id = p_item_id
      RETURNING unit_amount INTO v_unit_amount;

    IF NOT FOUND THEN
      RAISE EXCEPTION '指定された見積もりがこの商品明細に見つかりません';
    END IF;

    -- 4. 選択された場合はunit_amount × GREATEST(quantity,1)でamountを自動更新
    UPDATE public.purchase_request_items
      SET amount = v_unit_amount * GREATEST(COALESCE(v_item.quantity, 1), 1),
          amount_manually_overridden = false
      WHERE id = p_item_id;
  ELSE
    -- 選択解除の場合は既存amountを維持しつつ、手動上書き扱いにする
    UPDATE public.purchase_request_items
      SET amount_manually_overridden = true
      WHERE id = p_item_id;
  END IF;
END;
$$;
