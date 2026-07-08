-- 「用途」（何に使うかの分類）とは別に、「なぜ必要か・組織として必要なコストか」を
-- 承認者が判断できるよう、独立した申請理由欄を追加する。
-- 相見積もり必須化のしきい値（1万円）と同じ基準で、金額が大きいほど組織への影響が
-- 大きいことから、1万円超の申請では必須にする。
ALTER TABLE public.purchase_requests
  ADD COLUMN reason text;

-- NOT VALID: 既存行（reason未入力の過去データ）は検証対象外にし、
-- 今後の新規行・更新行にのみ適用する
ALTER TABLE public.purchase_requests
  ADD CONSTRAINT purchase_requests_reason_required_check
  CHECK (
    request_type != 'purchase_request'
    OR amount <= 10000
    OR (reason IS NOT NULL AND length(trim(reason)) > 0)
  ) NOT VALID;

-- submit_purchase_request RPCにreasonの読み書きを追加する。
-- 今回の教訓（スキーマ変更とRPCの追従漏れでCHECK制約が常に失敗していた）を踏まえ、
-- 列追加と同じマイグレーションでRPCも更新する。
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
      id, purchase_request_id, sort_order, item_name, quantity, amount, amount_manually_overridden, store_name
    ) VALUES (
      gen_random_uuid(), p_request_id, v_item_sort,
      v_item->>'item_name', (v_item->>'quantity')::integer, (v_item->>'amount')::integer,
      COALESCE((v_item->>'amount_manually_overridden')::boolean, false), v_item->>'store_name'
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
