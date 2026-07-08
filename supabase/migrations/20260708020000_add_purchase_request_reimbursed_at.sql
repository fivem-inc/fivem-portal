-- 立替払い（payment_method='cash'）の申請について、実際に返金済みかどうかを
-- 管理者が記録できるようにする。NULLなら未返金、日時が入っていれば返金済みとみなす。
ALTER TABLE public.purchase_requests
  ADD COLUMN reimbursed_at timestamptz;
