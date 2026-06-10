create table notifications (
  id uuid default gen_random_uuid() primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  message text not null,
  sub_message text,
  read boolean default false,
  created_at timestamptz default now()
);

alter table notifications enable row level security;

create policy "Users can view own notifications"
  on notifications for select
  using (user_id = auth.uid());

create policy "Approvers can insert notifications"
  on notifications for insert
  with check (
    exists (
      select 1 from profiles
      where id = auth.uid()
        and role_title in ('リーダー', 'マネージャー', '社長', '管理者')
    )
    or (auth.jwt() ->> 'role') = 'admin'
  );

create policy "Users can update own notifications"
  on notifications for update
  using (user_id = auth.uid());
