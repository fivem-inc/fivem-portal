-- 備品購入申請・経費精算 Phase 4（その1）
-- 3万円超は「全マネージャー＋社長」全員承認フローとする。今回はスキーマ（列・制約）のみ追加する。
-- 承認対象者の自動選出トリガー・ゲートトリガー・RLS・RPCは後続のmigrationファイルで追加する。
--
-- 金額帯としきい値は複数の制約に登場するため、変更時は下記を確認すること：
--   1. purchase_requests_amount_band_check（Phase3で追加された3万円超ガード。今回撤廃する）
--   2. purchase_requests_type_status_check（金額帯とstatus/承認ルートの整合。今回3万円超の分岐を追加）
--   3. purchase_requests_board_approver_ids_check（新規、3万円超・通常フロー時はboard_approver_idsが必須）
--   4. purchase_requests_president_self_judgment_check（新規、president_self_judgmentは社長かつ3万円超のみ許可）

-- ========================================
-- 1. 3万円超ガード（Phase3で追加）を撤廃する
-- ========================================
ALTER TABLE public.purchase_requests
  DROP CONSTRAINT purchase_requests_amount_band_check;

-- ========================================
-- 2. Phase4用の追加列
-- ========================================
ALTER TABLE public.purchase_requests
  -- 全マネージャー+社長のスナップショット（申請者自身は除外）。3万円超・通常フロー時のみNOT NULL相当（CHECK制約で保証）
  ADD COLUMN board_approver_ids uuid[],
  ADD COLUMN board_approved_at timestamptz,
  -- 社長自身が申請者になった場合のみ意味を持つ。true=自己判断（共有のみ）、false=全マネージャーに審議を依頼
  ADD COLUMN president_self_judgment boolean NOT NULL DEFAULT false;

CREATE INDEX idx_purchase_requests_board_approvers ON public.purchase_requests USING GIN (board_approver_ids);

-- ========================================
-- 3. status拡張: pending_board（全員承認待ち）・board_approved（全員承認完了・自動確定）を追加
-- ========================================
ALTER TABLE public.purchase_requests
  DROP CONSTRAINT purchase_requests_status_check;
ALTER TABLE public.purchase_requests
  ADD CONSTRAINT purchase_requests_status_check
  CHECK (status IN ('recorded', 'pending_leader', 'leader_approved', 'pending_manager', 'manager_approved', 'self_judgment_shared', 'pending_board', 'board_approved', 'returned'));

-- ========================================
-- 4. request_typeとstatusの組み合わせを、3万円超（社長自己判断 or 全員承認）にも拡張する
-- ========================================
ALTER TABLE public.purchase_requests
  DROP CONSTRAINT purchase_requests_type_status_check;
ALTER TABLE public.purchase_requests
  ADD CONSTRAINT purchase_requests_type_status_check
  CHECK (
    (request_type = 'reimbursement' AND status = 'recorded')
    OR (request_type = 'purchase_request' AND amount <= 10000 AND NOT is_self_judgment AND status IN ('pending_leader', 'leader_approved', 'returned'))
    OR (request_type = 'purchase_request' AND amount <= 10000 AND is_self_judgment AND status = 'self_judgment_shared')
    OR (request_type = 'purchase_request' AND amount > 10000 AND amount <= 30000 AND NOT is_self_judgment AND status IN ('pending_manager', 'manager_approved', 'returned'))
    OR (request_type = 'purchase_request' AND amount > 10000 AND amount <= 30000 AND is_self_judgment AND status = 'self_judgment_shared')
    -- 3万円超・社長の自己判断（共有のみ）ルート
    OR (request_type = 'purchase_request' AND amount > 30000 AND president_self_judgment AND status = 'self_judgment_shared')
    -- 3万円超・全マネージャー+社長の全員承認ルート
    OR (request_type = 'purchase_request' AND amount > 30000 AND NOT president_self_judgment AND status IN ('pending_board', 'board_approved', 'returned'))
  );

-- ========================================
-- 5. board_approver_idsは3万円超・通常フロー（president_self_judgment=false）時はNULL/空配列であってはならない
-- ========================================
ALTER TABLE public.purchase_requests
  ADD CONSTRAINT purchase_requests_board_approver_ids_check
  CHECK (
    NOT (request_type = 'purchase_request' AND amount > 30000 AND NOT president_self_judgment)
    OR (board_approver_ids IS NOT NULL AND array_length(board_approver_ids, 1) >= 1)
  );

-- ========================================
-- 6. president_self_judgmentは申請者役職が'社長'かつamount>30000の場合のみtrueにできる
-- ========================================
ALTER TABLE public.purchase_requests
  ADD CONSTRAINT purchase_requests_president_self_judgment_check
  CHECK (
    NOT president_self_judgment
    OR (applicant_role_title = '社長' AND amount > 30000)
  );
