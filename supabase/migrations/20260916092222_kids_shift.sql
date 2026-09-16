-- ⑤ こどもシフト表（2026-09-16・段階1の1回目）
-- 設計・決めたこと・レビューは docs/計画-管理画面の開放.md の 5-9〜5-9-2。
--
-- ・置き場所（kids_shift_places）×曜日のマス（kids_shift_cells）を「いつから」で版にする
--   （変えたマスだけ・先の版は残す・今日より前は確認・stale で断る＝勤務表・掃除担当表と同じ流儀）
-- ・置き場所は3種類：列（本校3F・西陣校・園指導 …）／校の見出し（授業準備・フロント）／曜日の書き添え
--   🚨 レビュー K2：鍵を nullable にすると期間の重なりを止められない（null どうしは一致しない）ので、
--      置き場所を1つの表にして place_id を not null にしてある
-- ・マスの中身は行（kids_shift_items）＋人（kids_shift_item_people）。
--   🚨 レビュー K3：版用と案用で表を分けない。cell_id か plan_cell_id のどちらか1つだけが入る
-- ・案（kids_shift_plans）は「変えたマスだけ」を持つ（触っていないマスは決定済みの表から借りる）。
--   決定したら案のマスを決定済みの表へ入れて、案はしまう。しまった案は2年で cron が消す
--   🚨 レビュー K1：案のマスは「写した元の版 ID」と「そのときの中身の署名」の両方を持つ。
--      同じ適用開始日のその場の直しは版 ID が変わらないため、署名でないと気づけない
-- ・⚠️・追加必要・社員休みは保存しない（画面が週のシフトから計算する）。「確認した」だけ kids_shift_acks に残す
-- ・呼び名は掃除担当表で作った staff_display_names をそのまま使う（新しく作らない）
-- 🚨 名前入りの中身（紙の案1）はこのファイルに入れない（リポジトリが Public のため）。一覧と設定だけ seed する

-- ───────────────────────────────────────────
-- 1. 表
-- ───────────────────────────────────────────
-- 置き場所。kind='column'（表の列）／'head'（校の見出し）／'daynote'（曜日の書き添え）
create table if not exists public.kids_shift_places (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('column', 'head', 'daynote')),
  school text,
  floor text check (floor is null or length(btrim(floor)) between 1 and 10),
  label text not null check (length(btrim(label)) between 1 and 30),
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint kids_shift_places_head_school check (kind <> 'head' or (school is not null and floor is null)),
  constraint kids_shift_places_daynote check (kind <> 'daynote' or (school is null and floor is null))
);

-- 🚨 有効な置き場所は（種類・校・階）でひとつ（レビュー K10）
create unique index if not exists kids_shift_places_uniq
  on public.kids_shift_places (kind, coalesce(school, ''), coalesce(floor, '')) where active;

-- 行の種類（管理者が画面から足す・名前を変える・隠す）
create table if not exists public.kids_shift_row_kinds (
  key text primary key check (key ~ '^[a-z_]{2,20}$'),
  label text not null check (length(btrim(label)) between 1 and 20),
  has_class boolean not null default false,   -- クラス名を持つ
  has_groups boolean not null default false,  -- 班の数・必要な人数を持つ
  has_people boolean not null default true,   -- 担当・勤務中（担当しない）を持つ
  issue_mode text not null default 'full' check (issue_mode in ('full', 'day_only')),
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 校の見出しの役割（授業準備・フロント・受付・授業）
create table if not exists public.kids_shift_role_kinds (
  key text primary key check (key ~ '^[a-z_]{2,20}$'),
  label text not null check (length(btrim(label)) between 1 and 20),
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 決定済みの表のマス（版）
create table if not exists public.kids_shift_cells (
  id uuid primary key default gen_random_uuid(),
  place_id uuid not null references public.kids_shift_places(id) on delete cascade,
  day_kind text not null check (day_kind in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')),
  valid_from date not null,
  valid_to date,
  saved_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint kids_shift_cells_range check (valid_to is null or valid_to >= valid_from),
  constraint kids_shift_cells_no_overlap
    exclude using gist (place_id with =, day_kind with =, daterange(valid_from, valid_to, '[]') with &&)
);

create index if not exists kids_shift_cells_place_idx on public.kids_shift_cells (place_id, day_kind, valid_from);

-- 案
create table if not exists public.kids_shift_plans (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 40),
  apply_from date not null,
  status text not null default 'open' check (status in ('open', 'archived')),
  archived_reason text check (archived_reason is null or archived_reason in ('decided', 'unused')),
  archived_at timestamptz,
  decided_from date,
  revision integer not null default 0,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  constraint kids_shift_plans_archived check (
    (status = 'open' and archived_reason is null and archived_at is null)
    or (status = 'archived' and archived_reason is not null and archived_at is not null)
  )
);

create index if not exists kids_shift_plans_status_idx on public.kids_shift_plans (status, archived_at);

-- 案のマス（変えたマスだけ）
-- 🚨 base_cell_id＝写した元の版／base_sig＝そのときの中身の署名（同じ日付のその場の直しを見つけるため）
create table if not exists public.kids_shift_plan_cells (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.kids_shift_plans(id) on delete cascade,
  place_id uuid not null references public.kids_shift_places(id) on delete cascade,
  day_kind text not null check (day_kind in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')),
  base_cell_id uuid references public.kids_shift_cells(id) on delete set null,
  base_sig text not null default '',
  saved_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (plan_id, place_id, day_kind)
);

-- マスの中身（行）。🚨 cell_id か plan_cell_id のどちらか1つだけ
create table if not exists public.kids_shift_items (
  id uuid primary key default gen_random_uuid(),
  cell_id uuid references public.kids_shift_cells(id) on delete cascade,
  plan_cell_id uuid references public.kids_shift_plan_cells(id) on delete cascade,
  kind_key text not null check (length(kind_key) between 1 and 20),
  start_time time,
  end_time time,
  class_name text check (class_name is null or length(btrim(class_name)) between 1 and 30),
  groups integer check (groups is null or groups between 1 and 9),
  required integer check (required is null or required between 0 and 20),
  min_lesson integer check (min_lesson is null or min_lesson between 0 and 20),
  role_key text check (role_key is null or length(role_key) between 1 and 20),
  is_none boolean not null default false,
  note text check (note is null or length(note) <= 200),
  sort_order integer not null,
  constraint kids_shift_items_owner check (num_nonnulls(cell_id, plan_cell_id) = 1),
  constraint kids_shift_items_time check (end_time is null or start_time is null or end_time > start_time)
);

create index if not exists kids_shift_items_cell_idx on public.kids_shift_items (cell_id, sort_order);
create index if not exists kids_shift_items_plan_cell_idx on public.kids_shift_items (plan_cell_id, sort_order);

-- 行に入る人。🚨 profiles に CASCADE（2人共通の delete-user を止めないため）
-- role='lead'（担当）／'onduty'（勤務しているがこのクラスを担当しない）／'support'（サポート）
create table if not exists public.kids_shift_item_people (
  item_id uuid not null references public.kids_shift_items(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'lead' check (role in ('lead', 'onduty', 'support')),
  start_time time,
  end_time time,
  sort_order integer not null,
  primary key (item_id, sort_order),
  unique (item_id, user_id, role),
  constraint kids_shift_item_people_time check (end_time is null or start_time is null or end_time > start_time)
);

create index if not exists kids_shift_item_people_user_idx on public.kids_shift_item_people (user_id);

-- ⚠️ を「確認した」記録（2回目で画面に出す。表はここで作る＝あとから足すと保存と決定の関数を作り直すことになるため）
create table if not exists public.kids_shift_acks (
  id uuid primary key default gen_random_uuid(),
  cell_id uuid references public.kids_shift_cells(id) on delete cascade,
  plan_cell_id uuid references public.kids_shift_plan_cells(id) on delete cascade,
  issue_key text not null check (length(issue_key) between 1 and 300),
  acked_by uuid not null,
  acked_at timestamptz not null default now(),
  constraint kids_shift_acks_owner check (num_nonnulls(cell_id, plan_cell_id) = 1)
);

create unique index if not exists kids_shift_acks_cell_uniq on public.kids_shift_acks (cell_id, issue_key) where cell_id is not null;
create unique index if not exists kids_shift_acks_plan_uniq on public.kids_shift_acks (plan_cell_id, issue_key) where plan_cell_id is not null;

-- 表全体の書き添え
create table if not exists public.kids_shift_notes (
  id uuid primary key default gen_random_uuid(),
  body text not null check (length(btrim(body)) between 1 and 300),
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 設定（1行）
create table if not exists public.kids_shift_settings (
  id boolean primary key default true check (id),
  lesson_check boolean not null default true,
  required_by_groups jsonb not null default '{"1": 2, "2": 2, "3": 3}'::jsonb,
  min_lesson_by_groups jsonb not null default '{"1": 2, "2": 2, "3": 2}'::jsonb,
  plan_limit integer not null default 10 check (plan_limit between 1 and 50),
  updated_by uuid,
  updated_at timestamptz not null default now()
);

-- 人ごとの「レッスンできる」印（行が無ければ 正社員＝できる／パート＝できない）
create table if not exists public.kids_shift_staff_flags (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  can_lesson boolean not null,
  updated_by uuid,
  updated_at timestamptz not null default now()
);

drop trigger if exists kids_shift_places_updated_at on public.kids_shift_places;
create trigger kids_shift_places_updated_at before update on public.kids_shift_places
  for each row execute function public.set_updated_at();
drop trigger if exists kids_shift_row_kinds_updated_at on public.kids_shift_row_kinds;
create trigger kids_shift_row_kinds_updated_at before update on public.kids_shift_row_kinds
  for each row execute function public.set_updated_at();
drop trigger if exists kids_shift_role_kinds_updated_at on public.kids_shift_role_kinds;
create trigger kids_shift_role_kinds_updated_at before update on public.kids_shift_role_kinds
  for each row execute function public.set_updated_at();
drop trigger if exists kids_shift_cells_updated_at on public.kids_shift_cells;
create trigger kids_shift_cells_updated_at before update on public.kids_shift_cells
  for each row execute function public.set_updated_at();
drop trigger if exists kids_shift_plans_updated_at on public.kids_shift_plans;
create trigger kids_shift_plans_updated_at before update on public.kids_shift_plans
  for each row execute function public.set_updated_at();
drop trigger if exists kids_shift_plan_cells_updated_at on public.kids_shift_plan_cells;
create trigger kids_shift_plan_cells_updated_at before update on public.kids_shift_plan_cells
  for each row execute function public.set_updated_at();
drop trigger if exists kids_shift_notes_updated_at on public.kids_shift_notes;
create trigger kids_shift_notes_updated_at before update on public.kids_shift_notes
  for each row execute function public.set_updated_at();

-- 置き場所の見張り：校は校の一覧の値だけ。🚨 マスがある置き場所の校・階は変えられない
create or replace function public.kids_shift_places_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.school is not null
     and not exists (select 1 from public.master_options mo where mo.category = 'workplace' and mo.value = new.school) then
    raise exception '「%」という校はありません', new.school using errcode = '22023';
  end if;
  if tg_op = 'UPDATE' and (new.kind is distinct from old.kind
        or new.school is distinct from old.school or new.floor is distinct from old.floor)
     and exists (select 1 from public.kids_shift_cells c where c.place_id = old.id) then
    raise exception 'マスが入っている置き場所の種類・校・階は変えられません。新しい列を足して、この列を隠してください' using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists kids_shift_places_guard on public.kids_shift_places;
create trigger kids_shift_places_guard before insert or update on public.kids_shift_places
  for each row execute function public.kids_shift_places_guard();

-- 行の種類の見張り：🚨 中身が入っている種類は「持つ欄」を変えられない（レビュー K11）／勉強会は一覧に入れない
create or replace function public.kids_shift_row_kinds_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.key in ('study', 'role', 'daynote') then
    raise exception 'この種類の名前は使えません（勉強会は勉強会の画面から自動で出ます）' using errcode = '22023';
  end if;
  if tg_op = 'UPDATE'
     and (new.has_class is distinct from old.has_class or new.has_groups is distinct from old.has_groups
          or new.has_people is distinct from old.has_people)
     and exists (select 1 from public.kids_shift_items i where i.kind_key = old.key) then
    raise exception 'すでに使われている種類の「持つ欄」は変えられません' using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists kids_shift_row_kinds_guard on public.kids_shift_row_kinds;
create trigger kids_shift_row_kinds_guard before insert or update on public.kids_shift_row_kinds
  for each row execute function public.kids_shift_row_kinds_guard();

comment on table public.kids_shift_places is 'こどもシフト表の置き場所（列・校の見出し・曜日の書き添え）。消さずに隠す（2026-09-16）';
comment on table public.kids_shift_cells is 'こどもシフト表の決定済みのマスの版（置き場所×曜日×valid_from/valid_to）。書くのは kids_shift_save と kids_shift_plan_decide だけ';
comment on table public.kids_shift_plans is 'こどもシフト表の案（予定の適用開始日・作業中／しまった）。しまってから2年で cron が消す';
comment on table public.kids_shift_plan_cells is '案のマス（変えたマスだけ）。base_cell_id と base_sig で「決定済みの表でも直された」を見つける';
comment on table public.kids_shift_items is 'こどもシフト表の行（cell_id か plan_cell_id のどちらか1つ）。種類・時刻・クラス・班の数・必要な人数・役割・書き添え';
comment on table public.kids_shift_item_people is '行に入る人（lead＝担当／onduty＝勤務しているが担当しない／support＝サポート）と、人ごとの開始・終了';
comment on table public.kids_shift_acks is 'こどもシフト表の ⚠️ 印を「確認した」記録（マスの版×ずれの中身）';
comment on table public.kids_shift_notes is 'こどもシフト表の表全体の書き添え';
comment on table public.kids_shift_settings is 'こどもシフト表の設定（レッスンできる人の確かめ・班の数ごとの必要な人数と最低人数・作業中の案の上限）';
comment on table public.kids_shift_staff_flags is 'こどもシフト表の「レッスンできる」印（行が無ければ 正社員＝できる／パート＝できない）';

-- ───────────────────────────────────────────
-- 2. 読み書きの決まり（勤務表・掃除担当表と同じ判定）
-- ───────────────────────────────────────────
alter table public.kids_shift_places enable row level security;
alter table public.kids_shift_row_kinds enable row level security;
alter table public.kids_shift_role_kinds enable row level security;
alter table public.kids_shift_cells enable row level security;
alter table public.kids_shift_plans enable row level security;
alter table public.kids_shift_plan_cells enable row level security;
alter table public.kids_shift_items enable row level security;
alter table public.kids_shift_item_people enable row level security;
alter table public.kids_shift_acks enable row level security;
alter table public.kids_shift_notes enable row level security;
alter table public.kids_shift_settings enable row level security;
alter table public.kids_shift_staff_flags enable row level security;

-- 一覧・設定・印・書き添えは画面から直接書く（消さずに隠すので delete の許可は作らない）
do $$
declare
  t text;
begin
  foreach t in array array['kids_shift_places', 'kids_shift_row_kinds', 'kids_shift_role_kinds',
                           'kids_shift_notes', 'kids_shift_settings', 'kids_shift_staff_flags'] loop
    execute format('drop policy if exists %1$s_select on public.%1$s', t);
    execute format($p$create policy %1$s_select on public.%1$s
      for select to authenticated using ((select public.can_manage_admin_tab('shift_patterns')))$p$, t);
    execute format('drop policy if exists %1$s_insert on public.%1$s', t);
    execute format($p$create policy %1$s_insert on public.%1$s
      for insert to authenticated with check ((select public.can_manage_admin_tab('shift_patterns')))$p$, t);
    execute format('drop policy if exists %1$s_update on public.%1$s', t);
    execute format($p$create policy %1$s_update on public.%1$s
      for update to authenticated
      using ((select public.can_manage_admin_tab('shift_patterns')))
      with check ((select public.can_manage_admin_tab('shift_patterns')))$p$, t);
  end loop;
end;
$$;

-- マス・中身・人・案は読みだけ（書くのは関数）
do $$
declare
  t text;
begin
  foreach t in array array['kids_shift_cells', 'kids_shift_plans', 'kids_shift_plan_cells',
                           'kids_shift_items', 'kids_shift_item_people'] loop
    execute format('drop policy if exists %1$s_select on public.%1$s', t);
    execute format($p$create policy %1$s_select on public.%1$s
      for select to authenticated using ((select public.can_manage_admin_tab('shift_patterns')))$p$, t);
  end loop;
end;
$$;

drop policy if exists kids_shift_acks_select on public.kids_shift_acks;
create policy kids_shift_acks_select on public.kids_shift_acks
  for select to authenticated using ((select public.can_manage_admin_tab('shift_patterns')));
drop policy if exists kids_shift_acks_insert on public.kids_shift_acks;
create policy kids_shift_acks_insert on public.kids_shift_acks
  for insert to authenticated
  with check ((select public.can_manage_admin_tab('shift_patterns')) and acked_by = (select auth.uid()));
drop policy if exists kids_shift_acks_delete on public.kids_shift_acks;
create policy kids_shift_acks_delete on public.kids_shift_acks
  for delete to authenticated using ((select public.can_manage_admin_tab('shift_patterns')));

-- ───────────────────────────────────────────
-- 3. 最初の一覧（名前は入れない）
-- ───────────────────────────────────────────
insert into public.kids_shift_places (kind, school, floor, label, sort_order)
select p.kind, p.school, p.floor, p.label, p.sort_order
from (values
  ('head', '四条本校', null::text, '四条本校（見出し）', 10),
  ('column', '四条本校', '3F', '四条本校 3F', 20),
  ('column', '四条本校', '5F', '四条本校 5F', 30),
  ('column', '四条本校', '6F', '四条本校 6F', 40),
  ('head', '西陣校', null, '西陣校（見出し）', 50),
  ('column', '西陣校', null, '西陣校', 60),
  ('head', '上桂校', null, '上桂校（見出し）', 70),
  ('column', '上桂校', null, '上桂校', 80),
  ('head', '洛西口校', null, '洛西口校（見出し）', 90),
  ('column', '洛西口校', null, '洛西口校', 100),
  ('head', '南草津校', null, '南草津校（見出し）', 110),
  ('column', '南草津校', null, '南草津校', 120),
  ('column', null, null, '園指導', 130),
  ('daynote', null, null, '曜日の書き添え', 900)
) as p(kind, school, floor, label, sort_order)
where not exists (select 1 from public.kids_shift_places);

insert into public.kids_shift_row_kinds (key, label, has_class, has_groups, has_people, issue_mode, sort_order)
select k.key, k.label, k.has_class, k.has_groups, k.has_people, k.issue_mode, k.sort_order
from (values
  ('lesson', 'レッスン', true, true, true, 'full', 10),
  ('private', 'P', false, false, true, 'full', 20),
  ('meeting', '打合せ', false, false, true, 'full', 30),
  ('garden', '園指導', true, false, true, 'day_only', 40),
  ('adult', '大人コース業務', false, false, true, 'full', 50),
  ('other', 'その他', false, false, true, 'full', 60)
) as k(key, label, has_class, has_groups, has_people, issue_mode, sort_order)
where not exists (select 1 from public.kids_shift_row_kinds);

insert into public.kids_shift_role_kinds (key, label, sort_order)
select r.key, r.label, r.sort_order
from (values
  ('prep', '授業準備', 10),
  ('front', 'フロント', 20),
  ('reception', '受付・授業', 30)
) as r(key, label, sort_order)
where not exists (select 1 from public.kids_shift_role_kinds);

insert into public.kids_shift_settings (id) values (true) on conflict (id) do nothing;

-- ───────────────────────────────────────────
-- 4. 中身の署名と、開いた時点の目印
-- ───────────────────────────────────────────
-- 🚨 保存の「同じなら何もしない」と、案の「決定済みの表でも直された」の両方がこの署名を使う（1か所に寄せる）
create or replace function public.kids_shift_cell_sig(p_cell_id uuid, p_plan_cell_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(md5(string_agg(line, '|' order by ord)), '')
  from (
    select i.sort_order as ord,
           i.kind_key || '/' || coalesce(to_char(i.start_time, 'HH24:MI'), '') || '-' || coalesce(to_char(i.end_time, 'HH24:MI'), '')
             || '/' || coalesce(i.class_name, '') || '/' || coalesce(i.groups::text, '') || '/' || coalesce(i.required::text, '')
             || '/' || coalesce(i.min_lesson::text, '') || '/' || coalesce(i.role_key, '') || '/' || i.is_none::text
             || '/' || coalesce(i.note, '') || '/' ||
             coalesce((select string_agg(pe.user_id::text || ':' || pe.role || ':' ||
                                         coalesce(to_char(pe.start_time, 'HH24:MI'), '') || '-' ||
                                         coalesce(to_char(pe.end_time, 'HH24:MI'), ''), ',' order by pe.sort_order)
                         from public.kids_shift_item_people pe where pe.item_id = i.id), '') as line
      from public.kids_shift_items i
     where (p_cell_id is not null and i.cell_id = p_cell_id)
        or (p_plan_cell_id is not null and i.plan_cell_id = p_plan_cell_id)
  ) x;
$$;

comment on function public.kids_shift_cell_sig(uuid, uuid) is
  'こどもシフト表のマスの中身の署名（行と人をそろえた形の md5）。保存の「同じなら何もしない」と案の食い違い検出が使う（2026-09-16）';

revoke execute on function public.kids_shift_cell_sig(uuid, uuid) from public;
revoke execute on function public.kids_shift_cell_sig(uuid, uuid) from anon;
grant execute on function public.kids_shift_cell_sig(uuid, uuid) to authenticated;

create or replace function public.kids_shift_token()
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.can_manage_admin_tab('shift_patterns') then
    raise exception '権限がありません' using errcode = '42501';
  end if;
  return md5(
    coalesce((select string_agg(c.id::text || c.updated_at::text || coalesce(c.valid_to::text, '-'), ',' order by c.id)
                from public.kids_shift_cells c), '')
    || '|' ||
    coalesce((select string_agg(p.id::text || p.revision::text || p.status || p.apply_from::text, ',' order by p.id)
                from public.kids_shift_plans p), '')
  );
end;
$$;

comment on function public.kids_shift_token() is 'こどもシフト表の「開いた時点の目印」（版と案の状態）（2026-09-16）';

revoke execute on function public.kids_shift_token() from public;
revoke execute on function public.kids_shift_token() from anon;
grant execute on function public.kids_shift_token() to authenticated;

-- 送られてきた中身の署名。🚨 kids_shift_cell_sig と**同じ形**で作る（片方を直したら両方直す）
create or replace function public.kids_shift_payload_sig(p_items jsonb)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select coalesce(md5(string_agg(line, '|' order by ord)), '')
  from (
    select x.ord,
           (x.value->>'kind') || '/' ||
           coalesce(to_char(nullif(x.value->>'start', '')::time, 'HH24:MI'), '') || '-' ||
           coalesce(to_char(nullif(x.value->>'end', '')::time, 'HH24:MI'), '') || '/' ||
           coalesce(nullif(btrim(coalesce(x.value->>'class_name', '')), ''), '') || '/' ||
           coalesce(nullif(x.value->>'groups', '')::int::text, '') || '/' ||
           coalesce(nullif(x.value->>'required', '')::int::text, '') || '/' ||
           coalesce(nullif(x.value->>'min_lesson', '')::int::text, '') || '/' ||
           coalesce(nullif(x.value->>'role_key', ''), '') || '/' ||
           coalesce((x.value->>'is_none')::boolean, false)::text || '/' ||
           coalesce(nullif(btrim(coalesce(x.value->>'note', '')), ''), '') || '/' ||
           coalesce((select string_agg((y.value->>'user_id') || ':' || coalesce(nullif(y.value->>'role', ''), 'lead') || ':' ||
                                       coalesce(to_char(nullif(y.value->>'start', '')::time, 'HH24:MI'), '') || '-' ||
                                       coalesce(to_char(nullif(y.value->>'end', '')::time, 'HH24:MI'), ''), ',' order by y.ord)
                      from jsonb_array_elements(coalesce(x.value->'people', '[]'::jsonb)) with ordinality as y(value, ord)), '') as line
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as x(value, ord)
  ) z;
$$;

comment on function public.kids_shift_payload_sig(jsonb) is
  '送られてきたマスの中身の署名。🚨 kids_shift_cell_sig と同じ形（片方を直したら両方直す）（2026-09-16）';

revoke execute on function public.kids_shift_payload_sig(jsonb) from public;
revoke execute on function public.kids_shift_payload_sig(jsonb) from anon;
grant execute on function public.kids_shift_payload_sig(jsonb) to authenticated;

-- ───────────────────────────────────────────
-- 5. 中身の確かめと書き込み（保存・案・決定が共通で使う）
-- ───────────────────────────────────────────
-- 🚨 確かめは書き込みより前に全部済ませる（レビュー K3・S2）
create or replace function public.kids_shift_check_items(p_items jsonb)
returns void
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_person jsonb;
  v_kind text;
begin
  if jsonb_typeof(p_items) is distinct from 'array' then
    raise exception 'マスの中身の指定が正しくありません' using errcode = '22023';
  end if;
  if jsonb_array_length(p_items) > 40 then
    raise exception '1つのマスに入れられるのは40行までです' using errcode = '22023';
  end if;
  for v_item in select x.value from jsonb_array_elements(p_items) x loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception '行の指定が正しくありません' using errcode = '22023';
    end if;
    v_kind := coalesce(v_item->>'kind', '');
    if v_kind = 'role' then
      if not exists (select 1 from public.kids_shift_role_kinds r where r.key = coalesce(v_item->>'role_key', '')) then
        raise exception '見出しの役割が見つかりません' using errcode = 'P0002';
      end if;
    elsif v_kind = 'daynote' then
      null;  -- 曜日の書き添え（文だけ）
    elsif not exists (select 1 from public.kids_shift_row_kinds k where k.key = v_kind) then
      raise exception '行の種類「%」がありません', v_kind using errcode = 'P0002';
    end if;
    if coalesce(v_item->>'start', '') <> '' and (v_item->>'start') !~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' then
      raise exception '時刻は「9:30」の形で入れてください' using errcode = '22023';
    end if;
    if coalesce(v_item->>'end', '') <> '' and (v_item->>'end') !~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' then
      raise exception '時刻は「9:30」の形で入れてください' using errcode = '22023';
    end if;
    if coalesce(v_item->>'start', '') <> '' and coalesce(v_item->>'end', '') <> ''
       and (v_item->>'end')::time <= (v_item->>'start')::time then
      raise exception '終わりの時刻は、始まりより後にしてください' using errcode = '22023';
    end if;
    if length(coalesce(v_item->>'class_name', '')) > 30 then
      raise exception 'クラス名は30文字までです' using errcode = '22023';
    end if;
    if length(coalesce(v_item->>'note', '')) > 200 then
      raise exception '書き添えは200文字までです' using errcode = '22023';
    end if;
    if coalesce(v_item->>'groups', '') <> '' and ((v_item->>'groups')::int < 1 or (v_item->>'groups')::int > 9) then
      raise exception '班の数は1〜9で入れてください' using errcode = '22023';
    end if;
    if coalesce(v_item->>'required', '') <> '' and ((v_item->>'required')::int < 0 or (v_item->>'required')::int > 20) then
      raise exception '必要な人数は0〜20で入れてください' using errcode = '22023';
    end if;
    if coalesce(v_item->>'min_lesson', '') <> '' and ((v_item->>'min_lesson')::int < 0 or (v_item->>'min_lesson')::int > 20) then
      raise exception 'うちレッスンできる人の数は0〜20で入れてください' using errcode = '22023';
    end if;
    if jsonb_typeof(coalesce(v_item->'people', '[]'::jsonb)) <> 'array' then
      raise exception '人の指定が正しくありません' using errcode = '22023';
    end if;
    if jsonb_array_length(coalesce(v_item->'people', '[]'::jsonb)) > 12 then
      raise exception '1つの行に入れられるのは12人までです' using errcode = '22023';
    end if;
    for v_person in select y.value from jsonb_array_elements(coalesce(v_item->'people', '[]'::jsonb)) y loop
      if jsonb_typeof(v_person) <> 'object' or coalesce(v_person->>'user_id', '') !~ '^[0-9a-fA-F-]{36}$' then
        raise exception '人の指定が正しくありません' using errcode = '22023';
      end if;
      if not exists (select 1 from public.profiles p where p.id = (v_person->>'user_id')::uuid) then
        raise exception 'スタッフが見つかりません（削除された可能性があります）' using errcode = 'P0002';
      end if;
      if coalesce(v_person->>'role', 'lead') not in ('lead', 'onduty', 'support') then
        raise exception '人の役割の指定が正しくありません' using errcode = '22023';
      end if;
      if coalesce(v_person->>'start', '') <> '' and (v_person->>'start') !~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' then
        raise exception '人ごとの時刻は「9:30」の形で入れてください' using errcode = '22023';
      end if;
      if coalesce(v_person->>'end', '') <> '' and (v_person->>'end') !~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' then
        raise exception '人ごとの時刻は「9:30」の形で入れてください' using errcode = '22023';
      end if;
    end loop;
    if (select count(*) from jsonb_array_elements(coalesce(v_item->'people', '[]'::jsonb)) y)
       <> (select count(distinct (y.value->>'user_id') || ':' || coalesce(nullif(y.value->>'role', ''), 'lead'))
             from jsonb_array_elements(coalesce(v_item->'people', '[]'::jsonb)) y) then
      raise exception '同じ行に同じ人が同じ役割で2回入っています' using errcode = '22023';
    end if;
  end loop;
end;
$$;

revoke execute on function public.kids_shift_check_items(jsonb) from public;
revoke execute on function public.kids_shift_check_items(jsonb) from anon;

-- マスの中身を入れ替える（先に消してから入れる）
create or replace function public.kids_shift_put_items(p_cell_id uuid, p_plan_cell_id uuid, p_items jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_ord integer := 0;
  v_id uuid;
begin
  delete from public.kids_shift_items i
   where (p_cell_id is not null and i.cell_id = p_cell_id)
      or (p_plan_cell_id is not null and i.plan_cell_id = p_plan_cell_id);
  for v_item in select x.value from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) x loop
    v_ord := v_ord + 1;
    insert into public.kids_shift_items
      (cell_id, plan_cell_id, kind_key, start_time, end_time, class_name, groups, required, min_lesson,
       role_key, is_none, note, sort_order)
    values (p_cell_id, p_plan_cell_id, v_item->>'kind',
            nullif(v_item->>'start', '')::time, nullif(v_item->>'end', '')::time,
            nullif(btrim(coalesce(v_item->>'class_name', '')), ''),
            nullif(v_item->>'groups', '')::int, nullif(v_item->>'required', '')::int,
            nullif(v_item->>'min_lesson', '')::int, nullif(v_item->>'role_key', ''),
            coalesce((v_item->>'is_none')::boolean, false),
            nullif(btrim(coalesce(v_item->>'note', '')), ''), v_ord)
    returning id into v_id;
    insert into public.kids_shift_item_people (item_id, user_id, role, start_time, end_time, sort_order)
    select v_id, (y.value->>'user_id')::uuid, coalesce(nullif(y.value->>'role', ''), 'lead'),
           nullif(y.value->>'start', '')::time, nullif(y.value->>'end', '')::time, y.ord
      from jsonb_array_elements(coalesce(v_item->'people', '[]'::jsonb)) with ordinality as y(value, ord);
  end loop;
end;
$$;

revoke execute on function public.kids_shift_put_items(uuid, uuid, jsonb) from public;
revoke execute on function public.kids_shift_put_items(uuid, uuid, jsonb) from anon;

-- 決定済みの表に「その日から効く版」を用意する（同じ日付ならその場で直す・違えば前日で締めて新しい版・先の版は残す）
-- 戻り値：{ cell_id, kept_from }（kept_from が入っていれば、その日から先の版がそのまま残っている）
create or replace function public.kids_shift_open_version(p_place uuid, p_day text, p_from date)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cur public.kids_shift_cells%rowtype;
  v_to date;
  v_next date;
  v_id uuid;
begin
  select * into v_cur from public.kids_shift_cells c
   where c.place_id = p_place and c.day_kind = p_day
     and c.valid_from <= p_from and (c.valid_to is null or c.valid_to >= p_from);
  if found then
    if v_cur.valid_from = p_from then
      update public.kids_shift_cells set saved_by = auth.uid(), updated_at = now() where id = v_cur.id;
      return jsonb_build_object('cell_id', v_cur.id, 'kept_from', null);
    end if;
    v_to := v_cur.valid_to;
    update public.kids_shift_cells set valid_to = p_from - 1 where id = v_cur.id;
    insert into public.kids_shift_cells (place_id, day_kind, valid_from, valid_to, saved_by)
    values (p_place, p_day, p_from, v_to, auth.uid())
    returning id into v_id;
    return jsonb_build_object('cell_id', v_id, 'kept_from', case when v_to is null then null else (v_to + 1)::text end);
  end if;
  select min(c.valid_from) into v_next from public.kids_shift_cells c
   where c.place_id = p_place and c.day_kind = p_day and c.valid_from > p_from;
  insert into public.kids_shift_cells (place_id, day_kind, valid_from, valid_to, saved_by)
  values (p_place, p_day, p_from, v_next - 1, auth.uid())
  returning id into v_id;
  return jsonb_build_object('cell_id', v_id, 'kept_from', case when v_next is null then null else v_next::text end);
end;
$$;

revoke execute on function public.kids_shift_open_version(uuid, text, date) from public;
revoke execute on function public.kids_shift_open_version(uuid, text, date) from anon;

-- ───────────────────────────────────────────
-- 6. 決定済みの表を直す（変えたマスだけ）
-- ───────────────────────────────────────────
-- p_payload：{ "apply_from":"2026-10-01", "confirm_past":false, "base_token":"…",
--              "cells":[ { "place_id":uuid, "day_kind":"mon", "items":[ … ] }, … ] }
-- 戻り値：{ ok, reason('past_confirm'|'stale'|null), changed, unchanged, kept_future:[{place_id, day_kind, next_from}] }
create or replace function public.kids_shift_save(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_from date;
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_cell jsonb;
  v_place uuid;
  v_day text;
  v_sig_new text;
  v_sig_cur text;
  v_cur public.kids_shift_cells%rowtype;
  v_found boolean;
  v_open jsonb;
  v_changed integer := 0;
  v_unchanged integer := 0;
  v_kept jsonb := '[]'::jsonb;
begin
  if not public.can_manage_admin_tab('shift_patterns') then
    raise exception 'こどもシフト表を保存する権限がありません' using errcode = '42501';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception '保存する内容がありません' using errcode = '22023';
  end if;

  -- ── 確かめ（🚨 書き込みより前に全部済ませる） ──
  if coalesce(p_payload->>'apply_from', '') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception '適用開始日を入れてください' using errcode = '22023';
  end if;
  v_from := (p_payload->>'apply_from')::date;
  if jsonb_typeof(p_payload->'cells') is distinct from 'array' or jsonb_array_length(p_payload->'cells') = 0 then
    raise exception '保存するマスがありません' using errcode = '22023';
  end if;
  if jsonb_array_length(p_payload->'cells') > 200 then
    raise exception '一度に保存できるのは200マスまでです' using errcode = '22023';
  end if;
  if (select count(*) from jsonb_array_elements(p_payload->'cells') x)
     <> (select count(distinct (x.value->>'place_id') || (x.value->>'day_kind')) from jsonb_array_elements(p_payload->'cells') x) then
    raise exception '同じマスが2回入っています' using errcode = '22023';
  end if;

  for v_cell in select x.value from jsonb_array_elements(p_payload->'cells') x loop
    if jsonb_typeof(v_cell) <> 'object' or coalesce(v_cell->>'place_id', '') !~ '^[0-9a-fA-F-]{36}$' then
      raise exception 'マスの指定が正しくありません' using errcode = '22023';
    end if;
    if not exists (select 1 from public.kids_shift_places p where p.id = (v_cell->>'place_id')::uuid) then
      raise exception '置き場所が見つかりません（ほかの人が直した可能性があります）' using errcode = 'P0002';
    end if;
    if coalesce(v_cell->>'day_kind', '') not in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun') then
      raise exception '曜日の指定が正しくありません' using errcode = '22023';
    end if;
    perform public.kids_shift_check_items(v_cell->'items');
  end loop;

  if v_from < v_today and coalesce((p_payload->>'confirm_past')::boolean, false) is not true then
    return jsonb_build_object('ok', false, 'reason', 'past_confirm');
  end if;

  -- 🚨 保存・案・決定の3つで同じロックを使う（レビュー K5）
  perform pg_advisory_xact_lock(hashtext('kids_shift_save'));
  if coalesce(p_payload->>'base_token', '') <> public.kids_shift_token() then
    return jsonb_build_object('ok', false, 'reason', 'stale');
  end if;

  -- ── ここから書き込み（🚨 以降は ok:false を返さない。失敗は raise で全部取り消す） ──
  for v_cell in select x.value from jsonb_array_elements(p_payload->'cells') x loop
    v_place := (v_cell->>'place_id')::uuid;
    v_day := v_cell->>'day_kind';
    v_sig_new := public.kids_shift_payload_sig(v_cell->'items');

    select * into v_cur from public.kids_shift_cells c
     where c.place_id = v_place and c.day_kind = v_day
       and c.valid_from <= v_from and (c.valid_to is null or c.valid_to >= v_from);
    v_found := found;

    if v_found then
      v_sig_cur := public.kids_shift_cell_sig(v_cur.id, null);
      if v_sig_cur = v_sig_new then
        v_unchanged := v_unchanged + 1;
        continue;
      end if;
    else
      -- この日に効いている版が無い。空のままなら作らない
      if v_sig_new = public.kids_shift_payload_sig('[]'::jsonb) then
        v_unchanged := v_unchanged + 1;
        continue;
      end if;
    end if;

    v_open := public.kids_shift_open_version(v_place, v_day, v_from);
    perform public.kids_shift_put_items((v_open->>'cell_id')::uuid, null, v_cell->'items');
    if v_open->>'kept_from' is not null then
      v_kept := v_kept || jsonb_build_object('place_id', v_place, 'day_kind', v_day, 'next_from', v_open->>'kept_from');
    end if;
    v_changed := v_changed + 1;
  end loop;

  return jsonb_build_object('ok', true, 'reason', null, 'changed', v_changed, 'unchanged', v_unchanged, 'kept_future', v_kept);
end;
$$;

comment on function public.kids_shift_save(jsonb) is
  'こどもシフト表の決定済みの表を保存（変えたマスだけ版・先の版は残す・今日より前は確認・stale で断る）（2026-09-16）';

revoke execute on function public.kids_shift_save(jsonb) from public;
revoke execute on function public.kids_shift_save(jsonb) from anon;
grant execute on function public.kids_shift_save(jsonb) to authenticated;

-- ───────────────────────────────────────────
-- 7. 案（作る・写す・名前と予定日・マスを保存・しまう）
-- ───────────────────────────────────────────
-- p_payload の op：
--   'create' … { name, apply_from, copy_from:uuid|null }
--   'update' … { plan_id, revision, name, apply_from }
--   'cells'  … { plan_id, revision, cells:[{place_id, day_kind, items:[…]}] }
--   'archive'… { plan_id, revision }
-- 🚨 案のマスは「決定済みと同じ内容なら持たない」（ユーザー確定・案A：元に戻したマスは触っていない扱い）
create or replace function public.kids_shift_plan_save(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_op text;
  v_plan public.kids_shift_plans%rowtype;
  v_src public.kids_shift_plans%rowtype;
  v_limit integer;
  v_open_count integer;
  v_id uuid;
  v_from date;
  v_cell jsonb;
  v_place uuid;
  v_day text;
  v_sig_new text;
  v_sig_dec text;
  v_dec public.kids_shift_cells%rowtype;
  v_dec_id uuid;
  v_pc uuid;
  v_changed integer := 0;
  v_removed integer := 0;
  v_item record;
  v_new_item uuid;
begin
  if not public.can_manage_admin_tab('shift_patterns') then
    raise exception 'こどもシフト表の案を保存する権限がありません' using errcode = '42501';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception '保存する内容がありません' using errcode = '22023';
  end if;
  v_op := coalesce(p_payload->>'op', '');
  if v_op not in ('create', 'update', 'cells', 'archive') then
    raise exception '案の操作の指定が正しくありません' using errcode = '22023';
  end if;

  if v_op in ('create', 'update') then
    if length(btrim(coalesce(p_payload->>'name', ''))) = 0 then
      raise exception '案の名前を入れてください' using errcode = '22023';
    end if;
    if length(btrim(p_payload->>'name')) > 40 then
      raise exception '案の名前は40文字までです' using errcode = '22023';
    end if;
    if coalesce(p_payload->>'apply_from', '') !~ '^\d{4}-\d{2}-\d{2}$' then
      raise exception '予定の適用開始日を入れてください' using errcode = '22023';
    end if;
  end if;
  if v_op = 'cells' then
    if jsonb_typeof(p_payload->'cells') is distinct from 'array' or jsonb_array_length(p_payload->'cells') = 0 then
      raise exception '保存するマスがありません' using errcode = '22023';
    end if;
    if jsonb_array_length(p_payload->'cells') > 200 then
      raise exception '一度に保存できるのは200マスまでです' using errcode = '22023';
    end if;
    if (select count(*) from jsonb_array_elements(p_payload->'cells') x)
       <> (select count(distinct (x.value->>'place_id') || (x.value->>'day_kind')) from jsonb_array_elements(p_payload->'cells') x) then
      raise exception '同じマスが2回入っています' using errcode = '22023';
    end if;
    for v_cell in select x.value from jsonb_array_elements(p_payload->'cells') x loop
      if jsonb_typeof(v_cell) <> 'object' or coalesce(v_cell->>'place_id', '') !~ '^[0-9a-fA-F-]{36}$' then
        raise exception 'マスの指定が正しくありません' using errcode = '22023';
      end if;
      if not exists (select 1 from public.kids_shift_places p where p.id = (v_cell->>'place_id')::uuid) then
        raise exception '置き場所が見つかりません（ほかの人が直した可能性があります）' using errcode = 'P0002';
      end if;
      if coalesce(v_cell->>'day_kind', '') not in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun') then
        raise exception '曜日の指定が正しくありません' using errcode = '22023';
      end if;
      perform public.kids_shift_check_items(v_cell->'items');
    end loop;
  end if;

  perform pg_advisory_xact_lock(hashtext('kids_shift_save'));

  -- ── 作る（写して作ることもできる） ──
  if v_op = 'create' then
    select coalesce(s.plan_limit, 10) into v_limit from public.kids_shift_settings s where s.id;
    select count(*) into v_open_count from public.kids_shift_plans p where p.status = 'open';
    if v_open_count >= coalesce(v_limit, 10) then
      return jsonb_build_object('ok', false, 'reason', 'plan_limit', 'limit', coalesce(v_limit, 10));
    end if;
    insert into public.kids_shift_plans (name, apply_from, created_by, updated_by)
    values (btrim(p_payload->>'name'), (p_payload->>'apply_from')::date, auth.uid(), auth.uid())
    returning id into v_id;

    if coalesce(p_payload->>'copy_from', '') <> '' then
      select * into v_src from public.kids_shift_plans p where p.id = (p_payload->>'copy_from')::uuid;
      if not found then
        raise exception '写す元の案が見つかりません' using errcode = 'P0002';
      end if;
      for v_item in
        select pc.id as src_pc, pc.place_id, pc.day_kind from public.kids_shift_plan_cells pc where pc.plan_id = v_src.id
      loop
        -- 🚨 写した先の「元の版」は、新しい案の予定の適用開始日で引き直す（借りる日が変わるため）
        v_dec_id := null;  -- 🚨 見つからなかったときに前の周回の値が残らないようにする
        select c.id into v_dec_id from public.kids_shift_cells c
         where c.place_id = v_item.place_id and c.day_kind = v_item.day_kind
           and c.valid_from <= (p_payload->>'apply_from')::date
           and (c.valid_to is null or c.valid_to >= (p_payload->>'apply_from')::date);
        insert into public.kids_shift_plan_cells (plan_id, place_id, day_kind, base_cell_id, base_sig, saved_by)
        values (v_id, v_item.place_id, v_item.day_kind, v_dec_id,
                public.kids_shift_cell_sig(v_dec_id, null), auth.uid())
        returning id into v_pc;
        insert into public.kids_shift_items
          (plan_cell_id, kind_key, start_time, end_time, class_name, groups, required, min_lesson, role_key, is_none, note, sort_order)
        select v_pc, i.kind_key, i.start_time, i.end_time, i.class_name, i.groups, i.required, i.min_lesson,
               i.role_key, i.is_none, i.note, i.sort_order
          from public.kids_shift_items i where i.plan_cell_id = v_item.src_pc;
        -- 🚨 人は sort_order で新しい行と結び付ける（1つのマスの中で sort_order は重ならない）
        insert into public.kids_shift_item_people (item_id, user_id, role, start_time, end_time, sort_order)
        select ni.id, pe.user_id, pe.role, pe.start_time, pe.end_time, pe.sort_order
          from public.kids_shift_items oi
          join public.kids_shift_item_people pe on pe.item_id = oi.id
          join public.kids_shift_items ni on ni.plan_cell_id = v_pc and ni.sort_order = oi.sort_order
         where oi.plan_cell_id = v_item.src_pc;
      end loop;
    end if;

    select * into v_plan from public.kids_shift_plans p where p.id = v_id;
    return jsonb_build_object('ok', true, 'plan_id', v_id, 'revision', v_plan.revision);
  end if;

  -- ── ここから先は案を指定する操作 ──
  if coalesce(p_payload->>'plan_id', '') !~ '^[0-9a-fA-F-]{36}$' then
    raise exception '案の指定が正しくありません' using errcode = '22023';
  end if;
  select * into v_plan from public.kids_shift_plans p where p.id = (p_payload->>'plan_id')::uuid for update;
  if not found then
    raise exception '案が見つかりません（ほかの人が消した可能性があります）' using errcode = 'P0002';
  end if;
  if v_plan.status <> 'open' then
    return jsonb_build_object('ok', false, 'reason', 'archived');
  end if;
  if coalesce((p_payload->>'revision')::integer, -1) <> v_plan.revision then
    return jsonb_build_object('ok', false, 'reason', 'conflict', 'revision', v_plan.revision,
                              'updated_by', v_plan.updated_by, 'updated_at', v_plan.updated_at);
  end if;

  if v_op = 'update' then
    update public.kids_shift_plans
       set name = btrim(p_payload->>'name'), apply_from = (p_payload->>'apply_from')::date,
           revision = revision + 1, updated_by = auth.uid(), updated_at = now()
     where id = v_plan.id;
    return jsonb_build_object('ok', true, 'revision', v_plan.revision + 1);
  end if;

  if v_op = 'archive' then
    update public.kids_shift_plans
       set status = 'archived', archived_reason = 'unused', archived_at = now(),
           revision = revision + 1, updated_by = auth.uid(), updated_at = now()
     where id = v_plan.id;
    return jsonb_build_object('ok', true, 'revision', v_plan.revision + 1);
  end if;

  -- ── マスを保存する ──
  v_from := v_plan.apply_from;
  for v_cell in select x.value from jsonb_array_elements(p_payload->'cells') x loop
    v_place := (v_cell->>'place_id')::uuid;
    v_day := v_cell->>'day_kind';
    v_sig_new := public.kids_shift_payload_sig(v_cell->'items');

    select * into v_dec from public.kids_shift_cells c
     where c.place_id = v_place and c.day_kind = v_day
       and c.valid_from <= v_from and (c.valid_to is null or c.valid_to >= v_from);
    v_dec_id := case when found then v_dec.id else null end;
    v_sig_dec := public.kids_shift_cell_sig(v_dec_id, null);

    if v_sig_new = v_sig_dec then
      -- 決定済みと同じ内容に戻した＝案からは外す（触っていない扱い）
      delete from public.kids_shift_plan_cells pc
       where pc.plan_id = v_plan.id and pc.place_id = v_place and pc.day_kind = v_day;
      if found then v_removed := v_removed + 1; end if;
      continue;
    end if;

    insert into public.kids_shift_plan_cells (plan_id, place_id, day_kind, base_cell_id, base_sig, saved_by)
    values (v_plan.id, v_place, v_day, v_dec_id, v_sig_dec, auth.uid())
    on conflict (plan_id, place_id, day_kind)
      do update set base_cell_id = excluded.base_cell_id, base_sig = excluded.base_sig,
                    saved_by = excluded.saved_by, updated_at = now()
    returning id into v_pc;
    perform public.kids_shift_put_items(null, v_pc, v_cell->'items');
    v_changed := v_changed + 1;
  end loop;

  update public.kids_shift_plans
     set revision = revision + 1, updated_by = auth.uid(), updated_at = now()
   where id = v_plan.id;

  return jsonb_build_object('ok', true, 'revision', v_plan.revision + 1, 'changed', v_changed, 'removed', v_removed);
end;
$$;

comment on function public.kids_shift_plan_save(jsonb) is
  'こどもシフト表の案（作る・写す・名前と予定日・マスを保存・しまう）。決定済みと同じ内容のマスは案から外す（2026-09-16）';

revoke execute on function public.kids_shift_plan_save(jsonb) from public;
revoke execute on function public.kids_shift_plan_save(jsonb) from anon;
grant execute on function public.kids_shift_plan_save(jsonb) to authenticated;

-- ───────────────────────────────────────────
-- 8. 案を決定する（2回に分ける：1回目は何も書かずに一覧を返す）
-- ───────────────────────────────────────────
-- p_payload：{ plan_id, revision, apply_from, confirm:false|true, confirm_past:false, base_token,
--              choices:[{place_id, day_kind, use:'plan'|'decided'}] }
-- 1回目（confirm=false）の戻り値：{ ok:false, reason:'confirm', conflicts:[…], kept_future:[…], change_count, unchanged_count }
-- 2回目（confirm=true） の戻り値：{ ok:true, changed, unchanged, skipped, kept_future:[…] }
create or replace function public.kids_shift_plan_decide(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_plan public.kids_shift_plans%rowtype;
  v_from date;
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_pc record;
  v_dec public.kids_shift_cells%rowtype;
  v_dec_id uuid;
  v_sig_dec text;
  v_sig_plan text;
  v_use text;
  v_open jsonb;
  v_conflicts jsonb := '[]'::jsonb;
  v_kept jsonb := '[]'::jsonb;
  v_changed integer := 0;
  v_unchanged integer := 0;
  v_skipped integer := 0;
  v_next date;
begin
  if not public.can_manage_admin_tab('shift_patterns') then
    raise exception 'こどもシフト表を決定する権限がありません' using errcode = '42501';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
     or coalesce(p_payload->>'plan_id', '') !~ '^[0-9a-fA-F-]{36}$' then
    raise exception '案の指定が正しくありません' using errcode = '22023';
  end if;
  if coalesce(p_payload->>'apply_from', '') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception '適用開始日を入れてください' using errcode = '22023';
  end if;
  v_from := (p_payload->>'apply_from')::date;

  perform pg_advisory_xact_lock(hashtext('kids_shift_save'));

  select * into v_plan from public.kids_shift_plans p where p.id = (p_payload->>'plan_id')::uuid for update;
  if not found then
    raise exception '案が見つかりません（ほかの人が消した可能性があります）' using errcode = 'P0002';
  end if;
  if v_plan.status <> 'open' then
    return jsonb_build_object('ok', false, 'reason', 'archived');
  end if;
  if coalesce((p_payload->>'revision')::integer, -1) <> v_plan.revision then
    return jsonb_build_object('ok', false, 'reason', 'conflict', 'revision', v_plan.revision,
                              'updated_by', v_plan.updated_by, 'updated_at', v_plan.updated_at);
  end if;
  if coalesce(p_payload->>'base_token', '') <> public.kids_shift_token() then
    return jsonb_build_object('ok', false, 'reason', 'stale');
  end if;
  if v_from < v_today and coalesce((p_payload->>'confirm_past')::boolean, false) is not true then
    return jsonb_build_object('ok', false, 'reason', 'past_confirm');
  end if;

  -- ── 下調べ（1回目も2回目もここを通る。🚨 1回目は書き込みに進まない） ──
  for v_pc in
    select pc.id, pc.place_id, pc.day_kind, pc.base_sig, pl.label, pl.kind
      from public.kids_shift_plan_cells pc
      join public.kids_shift_places pl on pl.id = pc.place_id
     where pc.plan_id = v_plan.id
     order by pl.sort_order, pc.day_kind
  loop
    v_dec_id := null;
    select * into v_dec from public.kids_shift_cells c
     where c.place_id = v_pc.place_id and c.day_kind = v_pc.day_kind
       and c.valid_from <= v_from and (c.valid_to is null or c.valid_to >= v_from);
    if found then v_dec_id := v_dec.id; end if;
    v_sig_dec := public.kids_shift_cell_sig(v_dec_id, null);
    v_sig_plan := public.kids_shift_cell_sig(null, v_pc.id);

    if v_sig_plan = v_sig_dec then
      v_unchanged := v_unchanged + 1;
      continue;
    end if;

    if v_sig_dec <> v_pc.base_sig then
      v_conflicts := v_conflicts || jsonb_build_object(
        'place_id', v_pc.place_id, 'day_kind', v_pc.day_kind, 'label', v_pc.label);
    end if;

    -- 先の版が残るマス（画面に「◯/◯からは前のままです」と出す）
    if v_dec_id is not null and v_dec.valid_to is not null then
      v_kept := v_kept || jsonb_build_object('place_id', v_pc.place_id, 'day_kind', v_pc.day_kind,
                                             'next_from', (v_dec.valid_to + 1)::text);
    elsif v_dec_id is null then
      select min(c.valid_from) into v_next from public.kids_shift_cells c
       where c.place_id = v_pc.place_id and c.day_kind = v_pc.day_kind and c.valid_from > v_from;
      if v_next is not null then
        v_kept := v_kept || jsonb_build_object('place_id', v_pc.place_id, 'day_kind', v_pc.day_kind,
                                               'next_from', v_next::text);
      end if;
    end if;
    v_changed := v_changed + 1;
  end loop;

  if coalesce((p_payload->>'confirm')::boolean, false) is not true then
    return jsonb_build_object('ok', false, 'reason', 'confirm', 'conflicts', v_conflicts,
                              'kept_future', v_kept, 'change_count', v_changed, 'unchanged_count', v_unchanged);
  end if;

  -- ── ここから書き込み（🚨 以降は ok:false を返さない。失敗は raise で全部取り消す） ──
  v_changed := 0; v_unchanged := 0;
  for v_pc in
    select pc.id, pc.place_id, pc.day_kind, pc.base_sig
      from public.kids_shift_plan_cells pc where pc.plan_id = v_plan.id
  loop
    v_dec_id := null;
    select * into v_dec from public.kids_shift_cells c
     where c.place_id = v_pc.place_id and c.day_kind = v_pc.day_kind
       and c.valid_from <= v_from and (c.valid_to is null or c.valid_to >= v_from);
    if found then v_dec_id := v_dec.id; end if;
    v_sig_dec := public.kids_shift_cell_sig(v_dec_id, null);
    v_sig_plan := public.kids_shift_cell_sig(null, v_pc.id);

    if v_sig_plan = v_sig_dec then
      v_unchanged := v_unchanged + 1;
      continue;
    end if;

    -- ぶつかったマスは、画面で選んだほうを使う（既定は案の値）
    v_use := 'plan';
    if v_sig_dec <> v_pc.base_sig then
      select coalesce(c.value->>'use', 'plan') into v_use
        from jsonb_array_elements(coalesce(p_payload->'choices', '[]'::jsonb)) c
       where (c.value->>'place_id') = v_pc.place_id::text and (c.value->>'day_kind') = v_pc.day_kind
       limit 1;
      v_use := coalesce(v_use, 'plan');
    end if;
    if v_use = 'decided' then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    v_open := public.kids_shift_open_version(v_pc.place_id, v_pc.day_kind, v_from);
    -- 案のマスの中身を、決定済みの版へ写す
    delete from public.kids_shift_items i where i.cell_id = (v_open->>'cell_id')::uuid;
    insert into public.kids_shift_items
      (cell_id, kind_key, start_time, end_time, class_name, groups, required, min_lesson, role_key, is_none, note, sort_order)
    select (v_open->>'cell_id')::uuid, i.kind_key, i.start_time, i.end_time, i.class_name, i.groups, i.required,
           i.min_lesson, i.role_key, i.is_none, i.note, i.sort_order
      from public.kids_shift_items i where i.plan_cell_id = v_pc.id;
    insert into public.kids_shift_item_people (item_id, user_id, role, start_time, end_time, sort_order)
    select ni.id, pe.user_id, pe.role, pe.start_time, pe.end_time, pe.sort_order
      from public.kids_shift_items oi
      join public.kids_shift_item_people pe on pe.item_id = oi.id
      join public.kids_shift_items ni on ni.cell_id = (v_open->>'cell_id')::uuid and ni.sort_order = oi.sort_order
     where oi.plan_cell_id = v_pc.id;
    v_changed := v_changed + 1;
  end loop;

  update public.kids_shift_plans
     set status = 'archived', archived_reason = 'decided', archived_at = now(), decided_from = v_from,
         revision = revision + 1, updated_by = auth.uid(), updated_at = now()
   where id = v_plan.id;

  return jsonb_build_object('ok', true, 'changed', v_changed, 'unchanged', v_unchanged,
                            'skipped', v_skipped, 'kept_future', v_kept);
end;
$$;

comment on function public.kids_shift_plan_decide(jsonb) is
  'こどもシフト表の案を決定（1回目は書かずに一覧を返す・ぶつかったマスはマスごとに選ぶ・決定した案はしまう）（2026-09-16）';

revoke execute on function public.kids_shift_plan_decide(jsonb) from public;
revoke execute on function public.kids_shift_plan_decide(jsonb) from anon;
grant execute on function public.kids_shift_plan_decide(jsonb) to authenticated;

-- ───────────────────────────────────────────
-- 9. 掃除（しまってから2年の案を消す）
-- ───────────────────────────────────────────
-- 🚨 `5 19 * * *` ＝ UTC 19:05 ＝ 日本時間の朝4時5分。既存の掃除（UTC 18:00〜18:55）と重ならない時刻に置く
select cron.unschedule('purge-kids-shift-plans-daily')
 where exists (select 1 from cron.job where jobname = 'purge-kids-shift-plans-daily');

select cron.schedule('purge-kids-shift-plans-daily', '5 19 * * *', $cron$
delete from public.kids_shift_plans p
 where p.status = 'archived' and p.archived_at < now() - interval '2 years';
$cron$);

comment on function public.kids_shift_places_guard() is 'こどもシフト表の置き場所の見張り（校は校の一覧の値だけ・マスがある置き場所の校と階は変えられない）';
comment on function public.kids_shift_row_kinds_guard() is 'こどもシフト表の行の種類の見張り（勉強会の名前は使えない・使われている種類の「持つ欄」は変えられない）';

revoke execute on function public.kids_shift_places_guard() from public;
revoke execute on function public.kids_shift_places_guard() from anon;
revoke execute on function public.kids_shift_row_kinds_guard() from public;
revoke execute on function public.kids_shift_row_kinds_guard() from anon;
