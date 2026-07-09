-- 支払方法の構造変更
-- 大分類: cash（立替・返金あり）/ company_paid（会社支払・返金なし）
-- 会社支払を選んだ場合のみ、内訳（payment_method_detail）を選べる：
--   company_card（会社カード）/ bank_transfer（振込）/ cash_on_delivery（代引き）/ other（その他）
-- otherを選んだ場合のみ、payment_method_otherに自由記載の説明を入れる

ALTER TABLE public.purchase_requests
  ADD COLUMN payment_method_detail text,
  ADD COLUMN payment_method_other text;

-- 旧CHECK制約（'cash'/'company_card'の2値限定）を先に外す。
-- 外す前にUPDATEで'company_paid'をセットしようとすると、まだ有効な旧制約に違反してしまうため。
ALTER TABLE public.purchase_requests
  DROP CONSTRAINT purchase_requests_payment_method_check;

-- 既存の payment_method='company_card' データを新しい構造に移行
-- （旧来は「会社カード」自体が大分類の値だったが、今後は company_paid の内訳の1つになる）
UPDATE public.purchase_requests
SET payment_method = 'company_paid', payment_method_detail = 'company_card'
WHERE payment_method = 'company_card';

ALTER TABLE public.purchase_requests
  ADD CONSTRAINT purchase_requests_payment_method_check
  CHECK (payment_method IS NULL OR payment_method = ANY (ARRAY['cash', 'company_paid']));

ALTER TABLE public.purchase_requests
  ADD CONSTRAINT purchase_requests_payment_method_detail_check
  CHECK (payment_method_detail IS NULL OR payment_method_detail = ANY (ARRAY['company_card', 'bank_transfer', 'cash_on_delivery', 'other']));

-- 会社支払を選んだら内訳は必須
ALTER TABLE public.purchase_requests
  ADD CONSTRAINT purchase_requests_payment_method_detail_required_check
  CHECK (payment_method IS DISTINCT FROM 'company_paid' OR payment_method_detail IS NOT NULL);

-- 内訳「その他」を選んだら自由記載は必須
ALTER TABLE public.purchase_requests
  ADD CONSTRAINT purchase_requests_payment_method_other_required_check
  CHECK (payment_method_detail IS DISTINCT FROM 'other' OR (payment_method_other IS NOT NULL AND length(trim(payment_method_other)) > 0));
