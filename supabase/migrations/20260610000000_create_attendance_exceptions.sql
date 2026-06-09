create table attendance_exceptions (
  id uuid default gen_random_uuid() primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  date date not null,
  type text not null check (type in ('late', 'early_leave', 'absent')),
  actual_time time,
  notes text,
  created_by uuid references auth.users(id),
  created_at timestamptz default now()
);

alter table attendance_exceptions enable row level security;

-- 管理者・承認者は全件参照・追加・削除可
create policy "Approvers can manage attendance_exceptions"
  on attendance_exceptions for all
  using (
    (auth.jwt() ->> 'role') = 'admin'
    or exists (
      select 1 from profiles
      where id = auth.uid()
        and role_title in ('リーダー', 'マネージャー', '社長', '管理者')
    )
  );

-- 本人は自分のレコードを参照可
create policy "Users can view own attendance_exceptions"
  on attendance_exceptions for select
  using (user_id = auth.uid());
