-- 改ざん防止トリガー(protect_purchase_request_fields)が、管理者かどうかを見ずに
-- 「操作者がこの申請の承認者(leader_id/requested_manager_ids/board_approver_ids)に
-- 含まれているか」だけで判定していたため、管理者アカウントがたまたま承認者としても
-- 登録されている場合、管理画面からの正当な修正操作（承認メンバーを外す等）まで
-- ブロックされてしまう不具合を修正。管理者は常に許可する。

CREATE OR REPLACE FUNCTION public.protect_purchase_request_fields()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' THEN
    RETURN NEW;
  END IF;

  IF (auth.uid() = OLD.leader_id OR auth.uid() = ANY(OLD.requested_manager_ids) OR auth.uid() = ANY(OLD.board_approver_ids))
     AND auth.uid() IS DISTINCT FROM OLD.user_id THEN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id
      OR NEW.item_name IS DISTINCT FROM OLD.item_name
      OR NEW.quantity IS DISTINCT FROM OLD.quantity
      OR NEW.amount IS DISTINCT FROM OLD.amount
      OR NEW.purchased_at IS DISTINCT FROM OLD.purchased_at
      OR NEW.requested_purchase_date IS DISTINCT FROM OLD.requested_purchase_date
      OR NEW.instructed_by IS DISTINCT FROM OLD.instructed_by
      OR NEW.store_name IS DISTINCT FROM OLD.store_name
      OR NEW.purpose IS DISTINCT FROM OLD.purpose
      OR NEW.payment_method IS DISTINCT FROM OLD.payment_method
      OR NEW.notes IS DISTINCT FROM OLD.notes
      OR NEW.receipt_type IS DISTINCT FROM OLD.receipt_type
      OR NEW.receipt_missing_reason IS DISTINCT FROM OLD.receipt_missing_reason
      OR NEW.receipt_storage_path IS DISTINCT FROM OLD.receipt_storage_path
      OR NEW.quotes IS DISTINCT FROM OLD.quotes
      OR NEW.quote_file_path IS DISTINCT FROM OLD.quote_file_path
      OR NEW.leader_id IS DISTINCT FROM OLD.leader_id
      OR NEW.requested_manager_ids IS DISTINCT FROM OLD.requested_manager_ids
      OR NEW.shared_manager_ids IS DISTINCT FROM OLD.shared_manager_ids
      OR NEW.is_self_judgment IS DISTINCT FROM OLD.is_self_judgment
      OR NEW.board_approver_ids IS DISTINCT FROM OLD.board_approver_ids
      OR NEW.president_self_judgment IS DISTINCT FROM OLD.president_self_judgment
    THEN
      RAISE EXCEPTION '承認者は申請内容を変更できません（ステータスの更新のみ可能です）';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
