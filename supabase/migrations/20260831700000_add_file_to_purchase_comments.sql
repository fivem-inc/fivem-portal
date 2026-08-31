-- 備品購入申請の「質問・回答」に共有ファイルを持たせる。
--
-- ■ なぜ既存の見積もり欄に足さないのか
-- 承認の根拠になった相見積もり（purchase_request_item_quotes）は、承認が確定した
-- 時点で書き換えられない（RLSが status で拒否する）。承認後に見積書を差し替えられたら
-- 承認の意味がなくなるための正しい作りなので、ここは変更しない。
-- 一方で「承認のあとに業者から届く確定見積書・納品書・請求書を関係者に共有したい」
-- という実務がある。そこで、承認内容に影響しない追記型の質問・回答に持たせる。
--
-- ■ RLSは変更不要
--   prc_insert … author_id = auth.uid() かつ 親の申請が見えること（statusの制限なし）
--   prc_select … 親の申請が見えること
-- つまり承認済み（board_approved 等）の申請にも投稿でき、
-- 閲覧できる範囲は申請本体とまったく同じになる。
--
-- ■ 添付できる人を制限しない（2026-08-31 ユーザー決定）
-- 経理が請求書を貼る、承認者が参考資料を貼る、という使い方を塞がないため。
-- 誰が貼ったかは author_id と created_at で必ず残る。
--
-- ■ ファイルの実体
-- Storage の purchase-receipts バケットに置く。パスは
--   {user_id}/{request_id}/{timestamp}_quote.{ext}
-- とする。receipt-signed-url が「_quote. を含むパス＝見積書」として扱うため、
-- 閲覧できるのは 本人・リーダー・マネージャー・社長・管理者（既存の見積書と同じ）。
-- 🚨 パスの命名を変えるとこの判定から外れ、リーダー等が開けなくなる。

alter table public.purchase_request_comments
  add column if not exists file_path  text,
  add column if not exists file_label text;

comment on column public.purchase_request_comments.file_path is
  '共有ファイルの保存先（Storage: purchase-receipts）。未添付なら null。パスは *_quote.* とすること';
comment on column public.purchase_request_comments.file_label is
  'ファイルの種類の名札（確定見積書／納品書／請求書／カタログ・仕様書／その他の自由入力）';
