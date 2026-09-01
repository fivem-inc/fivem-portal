-- ============================================================
-- 場所予約：出欠に「支払い」の記入欄を足す（2026-09-01 ユーザー指示）
--
-- 何のための欄か:
--   プライベートは**別にある「10回区切りの一覧表」と照合**している。
--   その回が何回目なのかを、出欠と一緒に書き残せるようにする。
--   書き方（ユーザー説明）：
--     10回払いの人の2回目 → 「2/10」
--     1回払いの人の4回目  → 「4/1」
--   🚨 **分数ではない。「何回目 / 何回払い」**。計算に使わないこと。
--      だから型は数値ではなく**自由に書ける文字**にしてある。
--      書き方が変わっても画面を直さずに済む。
--
-- どの出欠のときに出すか:
--   room_attendance_options.payment_purposes で決める（画面から変えられる）。
--   空(null) = 支払い欄を出さない。用途が入っていれば**その用途のときだけ**出す。
--   初期値は「出席」「キャンセル料」の **プライベート**（2026-09-01 ユーザー確定）。
--   🚨 表示の出し分け（purposes）とは**別の列**にしている。
--      「出席」は全用途に出すが、支払い欄はプライベートだけ、という形にするため。
--
-- ロールバック手順:
--   alter table room_attendance_options drop column payment_purposes;
--   alter table room_booking_attendance drop column payment_note;
-- ============================================================

alter table room_attendance_options
  add column if not exists payment_purposes text[];

alter table room_booking_attendance
  add column if not exists payment_note text;

-- 初期値：プライベートの「出席」「キャンセル料」だけ支払い欄を出す
update room_attendance_options
   set payment_purposes = '{プライベート}', updated_at = now()
 where name in ('出席', 'キャンセル料');

-- 確認用:
--   select name, purposes, payment_purposes from room_attendance_options order by sort_order;
--   select count(*) from room_booking_attendance where payment_note is not null;
