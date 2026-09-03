-- ============================================================
-- 場所予約：出欠を付ける前でもメモを書けるようにする（2026-09-03 ユーザー指示）
--
-- 出欠の記録（room_booking_attendance）の status を null 可にする。
--   行の意味が「出欠」から「この参加者のこの回の記録（出欠 and/or メモ）」に広がる。
--   status が null ＝ まだ出欠を付けていない（メモだけの行）。
--
-- 🚨 メモだけの行は、画面・判定のすべてで**未入力扱い**にする（画面側で対応済み）：
--   ・集計／まとめて付けるの「入力済み」に数えない
--   ・空き扱い（room_booking_all_absent）は「参加者に空き扱いの出欠が付いているか」を
--     見るので、status null の行は空きの根拠にならない（null は = any に一致しない）
--   ・出欠を取り消すとき、メモがある行は消さずに status だけ空へ戻す
--     （メモを道連れにしない・画面側で対応済み）
--
-- ロールバック手順:
--   （status null の行を消してから）
--   alter table room_booking_attendance alter column status set not null;
-- ============================================================

alter table room_booking_attendance
  alter column status drop not null;

-- 確認用:
--   select is_nullable from information_schema.columns
--    where table_name = 'room_booking_attendance' and column_name = 'status';
