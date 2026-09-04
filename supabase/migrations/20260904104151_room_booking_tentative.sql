-- ============================================================
-- 場所予約：予約の「確認中」（2026-09-04 ユーザー承認）
--
-- 背景：お客様の返事待ちなど、まだ確定していない予定でも**場所と担当は押さえておきたい**。
--   押さえないと他の予約が入ってしまうため、予約として作りたい。ただし
--   画面では確定した予約と見分けが付く必要がある。
--
-- 作り：room_bookings.tentative（確認中の印・既定 false）。
--   🚨 **空きの判定・重なりの判定には一切効かせない**（room_create_booking /
--      room_check_conflict / room_staff_busy は触っていない）。確認中でも
--      今までどおり場所と担当を押さえる＝二重予約は防げる。見た目だけが変わる。
--   🚨 回ごとの印（2026-09-04 ユーザー確定）。繰り返しのルール（room_recurrences）には
--      持たせないので、月次更新で作られる回は常に「確定」で始まる。
--
-- ロールバック手順:
--   alter table room_bookings drop column if exists tentative;
-- ============================================================

alter table room_bookings
  add column if not exists tentative boolean not null default false;

comment on column room_bookings.tentative is
  '確認中（返事待ちなどで未確定・2026-09-04〜）。🚨 表示のみ。空き・重なりの判定には使わない';

-- 確認用:
--   select column_name, column_default from information_schema.columns
--    where table_name='room_bookings' and column_name='tentative';
--   select count(*) filter (where tentative) as tentative_cnt from room_bookings;
