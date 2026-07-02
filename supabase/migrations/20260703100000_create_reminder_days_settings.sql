-- 「締切の何日前にリマインドを送るか」を管理画面から編集できるようにする設定テーブル
-- event_key: 'encouragement_notify'（有給奨励日の未回答リマインド）
--            'remind_unread'（連絡板の締切未読リマインド）
-- days_before: 締切の何日前に送るかの配列（0=当日）

create table if not exists public.reminder_days_settings (
  event_key   text primary key,
  days_before int[] not null,
  updated_at  timestamptz not null default now()
);

insert into public.reminder_days_settings (event_key, days_before) values
  ('encouragement_notify', array[3, 0]),
  ('remind_unread',        array[1, 0])
on conflict (event_key) do nothing;

alter table public.reminder_days_settings enable row level security;

create policy "全員読み取り可"
  on public.reminder_days_settings
  for select
  to authenticated
  using (true);

create policy "管理者のみ編集可"
  on public.reminder_days_settings
  for all
  to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
