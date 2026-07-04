-- 備品購入申請・経費精算 Phase 4（その3）
-- 全員一致判定ゲート（enforce_board_opinions_complete）・RLSポリシー・改ざん防止トリガー拡張。
-- Phase3のenforce_manager_opinions_complete()・requested_manager_ids関連ポリシーは一切変更しない。

-- ========================================
-- 1. 全員回答完了・全員承認判定ゲート（Phase3のenforce_manager_opinions_completeとは別関数）
-- ========================================
CREATE OR REPLACE FUNCTION public.enforce_board_opinions_complete()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  opinion_count integer;
  approve_count integer;
  required_count integer;
BEGIN
  IF OLD.status = 'pending_board' AND NEW.status IN ('board_approved', 'returned') THEN
    required_count := COALESCE(array_length(NEW.board_approver_ids, 1), 0);
    -- 意見upsertとの競合を避けるため対象ラウンドの意見行をロックしてからカウントする
    SELECT count(*), count(*) FILTER (WHERE opinion = 'approve') INTO opinion_count, approve_count
      FROM public.purchase_request_manager_opinions
      WHERE purchase_request_id = NEW.id
        AND approval_round = NEW.approval_round
      FOR UPDATE;
    IF opinion_count < required_count THEN
      RAISE EXCEPTION '全員の回答が揃うまで最終決定はできません（%件中%件回答済み）', required_count, opinion_count;
    END IF;
    IF NEW.status = 'board_approved' AND approve_count < required_count THEN
      RAISE EXCEPTION '全員が承認している場合のみ全員承認として確定できます（否認を含む場合は差し戻してください）';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER purchase_requests_enforce_board_opinions_complete
  BEFORE UPDATE ON public.purchase_requests
  FOR EACH ROW EXECUTE FUNCTION public.enforce_board_opinions_complete();

-- ========================================
-- 2. RLSポリシー: board_approver_idsに含まれる者の参照・更新
-- ========================================
CREATE POLICY "pr_board_select" ON public.purchase_requests
  FOR SELECT USING (auth.uid() = ANY(board_approver_ids));

-- 依頼された誰か1人が最終決定（承認/差し戻し）できる。全員一致済みかどうかはenforce_board_opinions_completeで検証する
CREATE POLICY "pr_board_update" ON public.purchase_requests
  FOR UPDATE
  USING (auth.uid() = ANY(board_approver_ids) AND status = 'pending_board')
  WITH CHECK (auth.uid() = ANY(board_approver_ids) AND status IN ('board_approved', 'returned'));

-- 申請者の再申請許可ステータスにpending_boardを追加（既存の許可ステータスは維持しつつ追加するだけ）
DROP POLICY "pr_applicant_resubmit" ON public.purchase_requests;
CREATE POLICY "pr_applicant_resubmit" ON public.purchase_requests
  FOR UPDATE
  USING (user_id = auth.uid() AND status = 'returned')
  WITH CHECK (user_id = auth.uid() AND status IN ('pending_leader', 'pending_manager', 'pending_board'));

-- ========================================
-- 3. purchase_request_manager_opinionsのポリシーにboard_approver_idsのOR条件を追加
-- （Phase3の既存条件requested_manager_idsはそのまま維持し、条件を追加するだけ）
-- ========================================
DROP POLICY "opinion_select" ON public.purchase_request_manager_opinions;
CREATE POLICY "opinion_select" ON public.purchase_request_manager_opinions
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.purchase_requests pr
      WHERE pr.id = purchase_request_id
        AND (auth.uid() = ANY(pr.requested_manager_ids) OR auth.uid() = ANY(pr.board_approver_ids))
    )
    OR (
      visible_to_applicant
      AND EXISTS (SELECT 1 FROM public.purchase_requests pr WHERE pr.id = purchase_request_id AND pr.user_id = auth.uid())
    )
  );

DROP POLICY "opinion_insert" ON public.purchase_request_manager_opinions;
CREATE POLICY "opinion_insert" ON public.purchase_request_manager_opinions
  FOR INSERT WITH CHECK (
    manager_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.purchase_requests pr
      WHERE pr.id = purchase_request_id
        AND pr.approval_round = approval_round
        AND (
          (auth.uid() = ANY(pr.requested_manager_ids) AND pr.status = 'pending_manager')
          OR (auth.uid() = ANY(pr.board_approver_ids) AND pr.status = 'pending_board')
        )
    )
  );

DROP POLICY "opinion_update" ON public.purchase_request_manager_opinions;
CREATE POLICY "opinion_update" ON public.purchase_request_manager_opinions
  FOR UPDATE
  USING (manager_id = auth.uid())
  WITH CHECK (
    manager_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.purchase_requests pr
      WHERE pr.id = purchase_request_id
        AND pr.approval_round = approval_round
        AND (
          (auth.uid() = ANY(pr.requested_manager_ids) AND pr.status = 'pending_manager')
          OR (auth.uid() = ANY(pr.board_approver_ids) AND pr.status = 'pending_board')
        )
    )
  );

-- ========================================
-- 4. 改ざん防止トリガーにboard_approver_ids・president_self_judgment列を追加し、
-- 承認者判定にOLD.board_approver_idsも含める
-- ========================================
CREATE OR REPLACE FUNCTION public.protect_purchase_request_fields()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
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
