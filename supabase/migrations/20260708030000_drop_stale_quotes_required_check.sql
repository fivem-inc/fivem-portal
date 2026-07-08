-- 【重大バグ修正】複数商品対応（Phase5、submit_purchase_request RPC導入）以降、
-- 相見積もりは purchase_request_items 配下の新テーブルに保存されるようになり、
-- RPCは旧来の単一列 purchase_requests.quotes に一切書き込まなくなった。
-- しかし「1万円以上は2社以上必須」というCHECK制約が旧quotes列に残ったままだったため、
-- quotesは常にNULLとなり、1万円以上の申請が常にこのCHECK制約で失敗していた。
-- 相見積もりの必須チェックは商品ごとにクライアント側（PurchaseRequestForm.tsx）で
-- 行っているため、この旧制約は削除する。
ALTER TABLE public.purchase_requests
  DROP CONSTRAINT purchase_requests_quotes_required_check;
