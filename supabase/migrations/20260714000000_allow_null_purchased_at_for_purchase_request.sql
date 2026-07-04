-- 備品購入申請・経費精算 バグ修正
-- purchased_at（精算＝実際に購入した日）はテーブル作成時からnot nullだったが、
-- Phase2で「申請」フロー導入時に「購入予定日」を意味するrequested_purchase_date列を
-- 別途追加したことに伴い、申請フローではpurchased_atに値を入れない設計になっていた。
-- そのため申請フロー（request_type='purchase_request'）の新規申請が保存時に
-- 「null value in column "purchased_at" violates not-null constraint」で必ず失敗する
-- バグが、Phase2実装時から潜在していた。
--
-- 対応：purchased_at列自体のNOT NULL制約を外し、代わりに
-- 「精算フローの場合のみpurchased_atが必須」というCHECK制約に置き換える。

ALTER TABLE public.purchase_requests
  ALTER COLUMN purchased_at DROP NOT NULL;

ALTER TABLE public.purchase_requests
  ADD CONSTRAINT purchase_requests_purchased_at_required_for_reimbursement_check
  CHECK (request_type != 'reimbursement' OR purchased_at IS NOT NULL);
