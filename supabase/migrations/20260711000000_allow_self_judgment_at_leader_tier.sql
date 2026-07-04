-- 備品購入申請・経費精算 Phase 3（続き2）
-- 「自己判断（共有のみ）」はユーザーが任意で選ぶものではなく、申請者自身の役職の決裁権限で
-- 自動的に決まる仕様に変更したことに伴うDB制約の見直し。
--   ・リーダー以上（リーダー／マネージャー／社長）：1万円以下は決裁権限内のため自己判断可
--   ・マネージャー以上（マネージャー／社長）：1万円超〜3万円も決裁権限内のため自己判断可
-- フロント側は申請者の役職と金額を比較して自動判定するため、DB側は「1万円以下でも
-- is_self_judgment=trueを許容する」よう制約を緩めるだけでよい（役職チェック自体は
-- フロントとRLSのshared_manager_ids/requested_manager_idsの整合制約に委ねる）。

-- 旧: 自己判断は1万円超のみ許可、という制約は不要になったため削除
ALTER TABLE public.purchase_requests
  DROP CONSTRAINT purchase_requests_self_judgment_amount_check;

-- request_typeとstatusの組み合わせを、1万円以下でも自己判断ルートを持てるよう拡張
ALTER TABLE public.purchase_requests
  DROP CONSTRAINT purchase_requests_type_status_check;
ALTER TABLE public.purchase_requests
  ADD CONSTRAINT purchase_requests_type_status_check
  CHECK (
    (request_type = 'reimbursement' AND status = 'recorded')
    OR (request_type = 'purchase_request' AND amount <= 10000 AND NOT is_self_judgment AND status IN ('pending_leader', 'leader_approved', 'returned'))
    OR (request_type = 'purchase_request' AND amount <= 10000 AND is_self_judgment AND status = 'self_judgment_shared')
    OR (request_type = 'purchase_request' AND amount > 10000 AND NOT is_self_judgment AND status IN ('pending_manager', 'manager_approved', 'returned'))
    OR (request_type = 'purchase_request' AND amount > 10000 AND is_self_judgment AND status = 'self_judgment_shared')
  );
