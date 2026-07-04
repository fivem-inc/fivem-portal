-- 備品購入申請・経費精算 バグ修正（20260714000000のpurchased_atと同種の問題）
-- payment_method・receipt_typeもテーブル作成時から精算(reimbursement)フロー専用の
-- not null列だったが、Phase2で「申請」フロー導入時にこれらの入力項目自体を
-- 用意しなかったため、申請フローの新規申請が保存時に必ず失敗するバグがあった。
--
-- 対応：payment_method・receipt_type列自体のNOT NULL制約を外し、代わりに
-- 「精算フローの場合のみ両方とも必須」というCHECK制約を追加する。
-- 既存のpayment_method/receipt_typeの値チェック制約(ANY(...))・
-- receipt_missing_reasonとの組み合わせ制約は、値がNULLの場合はそもそも
-- 制約違反にならない（NULL比較はUNKNOWNとなりCHECKを通過する）ため変更不要。

ALTER TABLE public.purchase_requests
  ALTER COLUMN payment_method DROP NOT NULL;

ALTER TABLE public.purchase_requests
  ALTER COLUMN receipt_type DROP NOT NULL;

ALTER TABLE public.purchase_requests
  ADD CONSTRAINT purchase_requests_payment_receipt_required_for_reimbursement_check
  CHECK (request_type != 'reimbursement' OR (payment_method IS NOT NULL AND receipt_type IS NOT NULL));
