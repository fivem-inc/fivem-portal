-- 備品購入申請：1万円以上でも「1社しか選べない」場合の理由を残せるようにする
--
-- 【背景】相見積もりの入力が行き止まりになっていた
--   ・見出しは「価格比較（任意）」なのに、1万円以上は2社以上が必須
--   ・しかも「金額を直接入力する（相見積もりを使わない）」が最初から選ばれている
--   ・金額は業者を選んで初めて決まる（単価×数量）ので、入力の順序として破綻していた
--   実機で「3万円以上のとき、どう入力したらいいのか分からなかった」と指摘された。
--
--   さらに実務では、取扱いが1社しかない・緊急対応で相見積もりを取る時間がない、というケースがある。
--   逃げ道が無いと申請そのものができなくなるため、「1社しか選べない理由」を書けば送信できる形にする。
--   理由は承認者にも見えるので、安易な1社指定への歯止めになる。
--
--   理由は商品ごとに持たせる（相見積もりの必須判定も商品ごとに行っているため）。

ALTER TABLE public.purchase_request_items
  ADD COLUMN single_vendor_reason text;

-- submit_purchase_request RPC を single_vendor_reason 対応で上書きする
-- （20260718700000 の内容に、明細INSERTの1列だけ追加したもの）
CREATE OR REPLACE FUNCTION public.submit_purchase_request(p_request_id uuid, p_is_resubmit boolean, p_header jsonb, p_items jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
AS $function$
DECLARE
  v_item jsonb;
  v_quote jsonb;
  v_item_id uuid;
  v_item_sort integer := 0;
  v_quote_sort integer;
  v_items_subtotal integer := 0;
  v_requested_manager_ids uuid[];
  v_shared_manager_ids uuid[];
  v_board_approver_ids uuid[];
BEGIN
  IF jsonb_array_length(p_items) < 1 THEN
    RAISE EXCEPTION '商品は最低1件必要です';
  END IF;

  v_requested_manager_ids := (SELECT array_agg(x::uuid) FROM jsonb_array_elements_text(COALESCE(p_header->'requested_manager_ids', '[]'::jsonb)) x);
  v_shared_manager_ids := (SELECT array_agg(x::uuid) FROM jsonb_array_elements_text(COALESCE(p_header->'shared_manager_ids', '[]'::jsonb)) x);
  v_board_approver_ids := (SELECT array_agg(x::uuid) FROM jsonb_array_elements_text(COALESCE(p_header->'board_approver_ids', '[]'::jsonb)) x);

  IF p_is_resubmit THEN
    UPDATE public.purchase_requests SET
      amount = (p_header->>'amount')::integer,
      requested_purchase_date = (p_header->>'requested_purchase_date')::date,
      store_name = p_header->>'store_name',
      purpose = p_header->>'purpose',
      location = p_header->>'location',
      notes = p_header->>'notes',
      amount_diff_reason = p_header->>'amount_diff_reason',
      leader_id = NULLIF(p_header->>'leader_id', '')::uuid,
      requested_manager_ids = v_requested_manager_ids,
      shared_manager_ids = v_shared_manager_ids,
      board_approver_ids = v_board_approver_ids,
      is_self_judgment = COALESCE((p_header->>'is_self_judgment')::boolean, false),
      president_self_judgment = COALESCE((p_header->>'president_self_judgment')::boolean, false),
      status = p_header->>'status',
      returned_reason = null,
      leader_approved_at = null,
      manager_approved_at = null,
      board_approved_at = null,
      approval_round = approval_round + 1
      WHERE id = p_request_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION '再申請対象の申請が見つからないか、更新権限がありません';
    END IF;

    DELETE FROM public.purchase_request_items WHERE purchase_request_id = p_request_id;
  ELSE
    INSERT INTO public.purchase_requests (
      id, user_id, applicant_role_title, request_type,
      amount, requested_purchase_date, store_name, purpose, location, notes, amount_diff_reason,
      leader_id, requested_manager_ids, shared_manager_ids, board_approver_ids,
      is_self_judgment, president_self_judgment, status,
      item_name, quantity
    ) VALUES (
      p_request_id, auth.uid(), p_header->>'applicant_role_title', 'purchase_request',
      (p_header->>'amount')::integer, (p_header->>'requested_purchase_date')::date,
      p_header->>'store_name', p_header->>'purpose', p_header->>'location', p_header->>'notes', p_header->>'amount_diff_reason',
      NULLIF(p_header->>'leader_id', '')::uuid, v_requested_manager_ids, v_shared_manager_ids, v_board_approver_ids,
      COALESCE((p_header->>'is_self_judgment')::boolean, false),
      COALESCE((p_header->>'president_self_judgment')::boolean, false),
      p_header->>'status',
      p_items->0->>'item_name', (p_items->0->>'quantity')::integer
    );
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    INSERT INTO public.purchase_request_items (
      id, purchase_request_id, sort_order, item_name, quantity, amount, amount_manually_overridden, store_name,
      single_vendor_reason
    ) VALUES (
      gen_random_uuid(), p_request_id, v_item_sort,
      v_item->>'item_name', (v_item->>'quantity')::integer, (v_item->>'amount')::integer,
      COALESCE((v_item->>'amount_manually_overridden')::boolean, false), v_item->>'store_name',
      NULLIF(v_item->>'single_vendor_reason', '')
    ) RETURNING id INTO v_item_id;

    v_items_subtotal := v_items_subtotal + (v_item->>'amount')::integer;

    v_quote_sort := 0;
    IF v_item->'quotes' IS NOT NULL THEN
      FOR v_quote IN SELECT * FROM jsonb_array_elements(v_item->'quotes')
      LOOP
        INSERT INTO public.purchase_request_item_quotes (
          purchase_request_item_id, vendor, unit_amount, note, quote_file_path, is_selected, sort_order
        ) VALUES (
          v_item_id, v_quote->>'vendor', (v_quote->>'unit_amount')::integer, v_quote->>'note',
          v_quote->>'quote_file_path', COALESCE((v_quote->>'is_selected')::boolean, false), v_quote_sort
        );
        v_quote_sort := v_quote_sort + 1;
      END LOOP;
    END IF;

    v_item_sort := v_item_sort + 1;
  END LOOP;

  UPDATE public.purchase_requests SET items_subtotal = v_items_subtotal WHERE id = p_request_id;

  RETURN p_request_id;
END;
$function$;
