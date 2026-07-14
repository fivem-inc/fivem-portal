-- 社内お知らせ（管理者が全スタッフのホーム上部にバナー表示する連絡）。
-- 1お知らせ=1行なので、この表そのものが「いつ何を出したか」の履歴になる。
create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.announcements enable row level security;

-- 全認証ユーザーが閲覧可（お知らせなので全員に見せる）
drop policy if exists announcements_select_all on public.announcements;
create policy announcements_select_all on public.announcements
  for select to authenticated using (true);

-- 作成・更新・削除は管理者のみ
drop policy if exists announcements_admin_write on public.announcements;
create policy announcements_admin_write on public.announcements
  for all to authenticated
  using (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role_title = '管理者'))
  with check (exists (select 1 from public.profiles p where p.id = auth.uid() and p.role_title = '管理者'));

create index if not exists idx_announcements_active_created
  on public.announcements (active, created_at desc);
