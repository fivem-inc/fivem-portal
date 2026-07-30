-- 備品購入申請：金額を手で上書きしたときの理由を残せるようにする
--
-- 【背景】金額は「選んだ業者の単価×数量」で自動計算されるが、手で上書きもできる。
--   総額見積（送料込み・値引き後・工事費込みなど）では単価×数量と一致しないため上書きが必要になるが、
--   **なぜ違う金額なのかを書く場所が無く、承認者が金額の根拠を追えなかった**。
--   上書きしたときだけ表示される任意の入力欄を設け、承認画面・履歴・管理画面・CSVに出す。
--
-- ⚠️ ベースは 20260745000000（breakdown追加済みの最新版）。
--   20260741000000 は reason・jsonb_typeof防御が欠けた壊れた版なので絶対にベースにしない。

ALTER TABLE public.purchase_request_items
  ADD COLUMN amount_override_note text;

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

  v_requested_manager_ids := (SELECT array_agg(x::uuid) FROM jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(p_header->'requested_manager_ids') = 'array' THEN p_header->'requested_manager_ids' ELSE '[]'::jsonb END
  ) x);
  v_shared_manager_ids := (SELECT array_agg(x::uuid) FROM jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(p_header->'shared_manager_ids') = 'array' THEN p_header->'shared_manager_ids' ELSE '[]'::jsonb END
  ) x);
  v_board_approver_ids := (SELECT array_agg(x::uuid) FROM jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(p_header->'board_approver_ids') = 'array' THEN p_header->'board_approver_ids' ELSE '[]'::jsonb END
  ) x);

  IF p_is_resubmit THEN
    UPDATE public.purchase_requests SET
      amount = (p_header->>'amount')::integer,
      requested_purchase_date = (p_header->>'requested_purchase_date')::date,
      store_name = p_header->>'store_name',
      purpose = p_header->>'purpose',
      reason = p_header->>'reason',
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
      amount, requested_purchase_date, store_name, purpose, reason, location, notes, amount_diff_reason,
      leader_id, requested_manager_ids, shared_manager_ids, board_approver_ids,
      is_self_judgment, president_self_judgment, status,
      item_name, quantity
    ) VALUES (
      p_request_id, auth.uid(), p_header->>'applicant_role_title', 'purchase_request',
      (p_header->>'amount')::integer, (p_header->>'requested_purchase_date')::date,
      p_header->>'store_name', p_header->>'purpose', p_header->>'reason', p_header->>'location', p_header->>'notes', p_header->>'amount_diff_reason',
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
      single_vendor_reason, breakdown, amount_override_note
    ) VALUES (
      gen_random_uuid(), p_request_id, v_item_sort,
      v_item->>'item_name', (v_item->>'quantity')::integer, (v_item->>'amount')::integer,
      COALESCE((v_item->>'amount_manually_overridden')::boolean, false), v_item->>'store_name',
      NULLIF(v_item->>'single_vendor_reason', ''), NULLIF(v_item->>'breakdown', ''),
      NULLIF(v_item->>'amount_override_note', '')
    ) RETURNING id INTO v_item_id;

    v_items_subtotal := v_items_subtotal + (v_item->>'amount')::integer;

    v_quote_sort := 0;
    IF jsonb_typeof(v_item->'quotes') = 'array' THEN
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
