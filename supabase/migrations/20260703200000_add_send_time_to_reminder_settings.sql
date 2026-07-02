-- リマインドの「何時何分に送るか」を管理画面から編集できるようにする
-- days_before は remind_scheduled では使わないため NOT NULL 制約を外す
-- send_hour / send_minute は日本時間（JST）で保存する

alter table public.reminder_days_settings
  alter column days_before drop not null;

alter table public.reminder_days_settings
  add column if not exists send_hour   int not null default 9,
  add column if not exists send_minute int not null default 0;

insert into public.reminder_days_settings (event_key, days_before, send_hour, send_minute) values
  ('remind_scheduled', null, 9, 0)
on conflict (event_key) do nothing;
