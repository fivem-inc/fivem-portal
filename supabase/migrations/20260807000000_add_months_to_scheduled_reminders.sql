-- 定期リマインドに「送る月」を追加する
--
-- きっかけ：「毎月1日 10時」の月目標リマインドが、年始休み（1/1〜1/4）の1月1日にも飛んでしまう。
--           1月だけ別の日に送りたいので、「1月を除いて毎月1日」と「1月だけ5日」の2件に分けられるようにする。
--
-- months: 送る月(1〜12)の配列。
--   既定は12か月すべて＝これまでとまったく同じ動き（登録済みの行はそのまま動き続ける）。
--   🚨 空配列は「全月に送る」として扱う（remind-scheduled 側も同じ）。
--      万一データが空になっても「静かに送られなくなる」事故にはせず、多く送る側に倒している。
--      画面側は0か月では保存できないようにしてある。

alter table public.board_scheduled_reminders
  add column if not exists months int[] not null default array[1,2,3,4,5,6,7,8,9,10,11,12];

-- 1〜12以外の値が入らないようにする（<@ は「含まれている」。空配列も通る＝上の全月扱いと整合）
alter table public.board_scheduled_reminders
  drop constraint if exists board_scheduled_reminders_months_valid;

alter table public.board_scheduled_reminders
  add constraint board_scheduled_reminders_months_valid
  check (months <@ array[1,2,3,4,5,6,7,8,9,10,11,12]);
