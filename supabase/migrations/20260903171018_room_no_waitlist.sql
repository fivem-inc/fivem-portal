-- ============================================================
-- 場所予約：「この回はキャンセル待ちの対象外」（2026-09-03 ユーザー承認）
--
-- 「この日だけは、並んでいる人がいても誰も入れない」という回ごとの印。
-- 枠の設定の「受付を締め切る」（並ぶこと自体を止める）とは別物。
--
-- 対象外の回は（画面側で対応）：
--   ・「空きあり（最短◯/◯）」の判定から除外
--   ・繰り上げ・空き枠化の日付選びで「対象外」と表示され、選べない
--   ・出欠で休みを付けても「繰り上げできます／空き枠にする」の案内が出ない
--
-- ロールバック手順:
--   alter table room_bookings drop column if exists no_waitlist;
-- ============================================================

alter table room_bookings
  add column if not exists no_waitlist boolean not null default false;

-- 確認用:
--   select column_name from information_schema.columns
--    where table_name = 'room_bookings' and column_name = 'no_waitlist';
