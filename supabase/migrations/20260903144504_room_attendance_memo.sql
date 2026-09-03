-- ============================================================
-- 場所予約：出欠にメモ欄を追加（2026-09-03 ユーザー指示）
--
-- 支払いの回数（payment_note）とは**別**の自由メモ。
-- 例：「次回は◯◯の内容で」「キャンセル料をもらいたい」など。
-- 出欠の記録（room_booking_attendance）に1列足すだけ。
-- 🚨 支払い欄と同じ流儀：打つたびに保存しない（離れたときと Enter だけ）。
--    出欠を付ける前には書けない（空の記録ができると集計で意味不明になるため）。
--
-- ロールバック手順:
--   alter table room_booking_attendance drop column if exists memo;
-- ============================================================

alter table room_booking_attendance
  add column if not exists memo text;

-- 確認用:
--   select column_name from information_schema.columns
--    where table_name = 'room_booking_attendance' and column_name = 'memo';
