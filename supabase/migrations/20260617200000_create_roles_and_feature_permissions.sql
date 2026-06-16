-- ========================================
-- 役職テーブル
-- ========================================
create table public.roles (
  id          uuid    primary key default gen_random_uuid(),
  name        text    not null unique,
  sort_order  int     not null default 0,
  is_fixed    boolean not null default false,  -- true = 削除・名前変更不可（管理者など）
  created_at  timestamptz not null default now()
);

-- デフォルト役職を挿入
insert into public.roles (name, sort_order, is_fixed) values
  ('パート',       1, false),
  ('一般',         2, false),
  ('リーダー',     3, false),
  ('マネージャー', 4, false),
  ('フロア責任者', 5, false),
  ('社長',         6, false),
  ('管理者',       7, true);

-- ========================================
-- 機能別権限テーブル
-- feature_key の一覧:
--   leave_request   休暇申請
--   leave_calendar  休暇カレンダー
--   leave_approvals 休暇承認ページ
--   shift_report    勤務変更申請
--   expense         交通費申請
--   trip_report     出張報告
--   board           連絡板
-- ========================================
create table public.feature_permissions (
  id          uuid    primary key default gen_random_uuid(),
  role_id     uuid    not null references public.roles(id) on delete cascade,
  feature_key text    not null,
  enabled     boolean not null default false,
  updated_at  timestamptz not null default now(),
  unique (role_id, feature_key)
);

-- デフォルト権限を挿入（現在の動作を再現）
do $$
declare
  r_part      uuid;
  r_general   uuid;
  r_leader    uuid;
  r_manager   uuid;
  r_floor     uuid;
  r_president uuid;
  r_admin     uuid;
begin
  select id into r_part      from public.roles where name = 'パート';
  select id into r_general   from public.roles where name = '一般';
  select id into r_leader    from public.roles where name = 'リーダー';
  select id into r_manager   from public.roles where name = 'マネージャー';
  select id into r_floor     from public.roles where name = 'フロア責任者';
  select id into r_president from public.roles where name = '社長';
  select id into r_admin     from public.roles where name = '管理者';

  -- パート: 交通費・出張報告・連絡板・勤務変更申請のみ
  insert into public.feature_permissions (role_id, feature_key, enabled) values
    (r_part, 'leave_request',   false),
    (r_part, 'leave_calendar',  false),
    (r_part, 'leave_approvals', false),
    (r_part, 'shift_report',    true),
    (r_part, 'expense',         true),
    (r_part, 'trip_report',     true),
    (r_part, 'board',           true);

  -- 一般: 交通費・出張報告・連絡板・休暇申請
  insert into public.feature_permissions (role_id, feature_key, enabled) values
    (r_general, 'leave_request',   true),
    (r_general, 'leave_calendar',  false),
    (r_general, 'leave_approvals', false),
    (r_general, 'shift_report',    false),
    (r_general, 'expense',         true),
    (r_general, 'trip_report',     true),
    (r_general, 'board',           true);

  -- リーダー: 全機能
  insert into public.feature_permissions (role_id, feature_key, enabled) values
    (r_leader, 'leave_request',   true),
    (r_leader, 'leave_calendar',  true),
    (r_leader, 'leave_approvals', true),
    (r_leader, 'shift_report',    true),
    (r_leader, 'expense',         true),
    (r_leader, 'trip_report',     true),
    (r_leader, 'board',           true);

  -- マネージャー: 全機能
  insert into public.feature_permissions (role_id, feature_key, enabled) values
    (r_manager, 'leave_request',   true),
    (r_manager, 'leave_calendar',  true),
    (r_manager, 'leave_approvals', true),
    (r_manager, 'shift_report',    true),
    (r_manager, 'expense',         true),
    (r_manager, 'trip_report',     true),
    (r_manager, 'board',           true);

  -- フロア責任者: 休暇カレンダーなし
  insert into public.feature_permissions (role_id, feature_key, enabled) values
    (r_floor, 'leave_request',   true),
    (r_floor, 'leave_calendar',  false),
    (r_floor, 'leave_approvals', true),
    (r_floor, 'shift_report',    true),
    (r_floor, 'expense',         true),
    (r_floor, 'trip_report',     true),
    (r_floor, 'board',           true);

  -- 社長: 全機能
  insert into public.feature_permissions (role_id, feature_key, enabled) values
    (r_president, 'leave_request',   true),
    (r_president, 'leave_calendar',  true),
    (r_president, 'leave_approvals', true),
    (r_president, 'shift_report',    true),
    (r_president, 'expense',         true),
    (r_president, 'trip_report',     true),
    (r_president, 'board',           true);

  -- 管理者: 全機能（is_fixed=true なので UI から変更不可）
  insert into public.feature_permissions (role_id, feature_key, enabled) values
    (r_admin, 'leave_request',   true),
    (r_admin, 'leave_calendar',  true),
    (r_admin, 'leave_approvals', true),
    (r_admin, 'shift_report',    true),
    (r_admin, 'expense',         true),
    (r_admin, 'trip_report',     true),
    (r_admin, 'board',           true);
end $$;

-- ========================================
-- profiles に role_id カラムを追加
-- （既存の role_title は残して互換性を保つ）
-- ========================================
alter table public.profiles
  add column if not exists role_id uuid references public.roles(id);

-- 既存スタッフの role_title → role_id を移行
update public.profiles p
set role_id = r.id
from public.roles r
where p.role_title = r.name;

-- ========================================
-- インデックス
-- ========================================
create index idx_feature_permissions_role on public.feature_permissions(role_id);

-- ========================================
-- RLS
-- ========================================
alter table public.roles enable row level security;
alter table public.feature_permissions enable row level security;

-- 全認証ユーザーが参照できる（メニュー表示判定に使用）
create policy "roles_select_authenticated" on public.roles
  for select to authenticated using (true);

create policy "feature_permissions_select_authenticated" on public.feature_permissions
  for select to authenticated using (true);

-- 管理者のみ変更可能
create policy "roles_admin_all" on public.roles
  for all to authenticated
  using ((auth.jwt() ->> 'role') = 'admin')
  with check ((auth.jwt() ->> 'role') = 'admin');

create policy "feature_permissions_admin_all" on public.feature_permissions
  for all to authenticated
  using ((auth.jwt() ->> 'role') = 'admin')
  with check ((auth.jwt() ->> 'role') = 'admin');
