-- 定期リマインドを柔軟にする
--   1. 1件ごとに送信時刻（何時何分）を持てるようにする
--   2. 「毎月◯日」に加えて「毎週◯曜日」も選べるようにする
--   3. 日付・曜日を複数選択できるようにする（day_of_month単一値 → frequency + days[]）
--
-- frequency: 'monthly'（毎月） or 'weekly'（毎週）
-- days: monthlyの場合は日付(1〜31)の配列、weeklyの場合は曜日(0=日〜6=土)の配列

alter table public.board_scheduled_reminders
  add column if not exists frequency text not null default 'monthly' check (frequency in ('monthly', 'weekly')),
  add column if not exists days int[] not null default array[1],
  add column if not exists send_hour   int not null default 9,
  add column if not exists send_minute int not null default 0;

-- 既存データがあれば移行してから古い列を削除
update public.board_scheduled_reminders
  set days = array[day_of_month]
  where day_of_month is not null;

alter table public.board_scheduled_reminders
  drop column if exists day_of_month;

-- 定期リマインドの共通1時刻の設定行はもう使わないため削除（前回追加した想定分）
delete from public.reminder_days_settings where event_key = 'remind_scheduled';
