-- 申請理由を金額に関わらず（1万円以下でも）必須にする
ALTER TABLE public.purchase_requests
  DROP CONSTRAINT purchase_requests_reason_required_check;

-- NOT VALID: 既存行（reason未入力の過去データ）は検証対象外にし、
-- 今後の新規行・更新行にのみ適用する
ALTER TABLE public.purchase_requests
  ADD CONSTRAINT purchase_requests_reason_required_check
  CHECK (
    request_type != 'purchase_request'
    OR (reason IS NOT NULL AND length(trim(reason)) > 0)
  ) NOT VALID;
