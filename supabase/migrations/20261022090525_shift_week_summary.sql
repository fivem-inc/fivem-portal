-- シフト表の「週の時間・週休」とシミュレーション（2026-10-22・docs/計画-シフト表の時間と週休.md）
--
-- ・週のまとめの計算は画面（lib/shiftWeekSummary.ts）。ここは設定と、案の中だけの前提・仮の人を持つ
-- ・決定済みの表：勤務時間＝勤務表（いつものシフト）／レッスン＝シフト表。目標の時間（既定40時間・正社員だけ）は人ごとに kids_shift_person_targets
-- ・作業中の案：勤務時間＝担当の前後（30分前〜15分後）から組み立てる。人ごとの前提（週休・目標・1日の目安・まとめて変えない）と、
--   人・曜日ごとの出勤／退勤の時刻・事務の時間は kids_shift_plan_people／kids_shift_plan_person_days（案の中だけ。勤務表・プロフィールには触らない）
-- ・仮の人（kids_shift_temps）：案のマスにだけ入れられる（トリガーで止める）。仮の人が残っている案は決定できない（kids_shift_plan_decide）
-- 🚨 マスの署名（cell_sig／payload_sig／画面の sigOfItems）は、今ある人（user_id）の形を変えない。仮の人だけ「temp:<id>」で足す
-- 🚨 関数は本番の実定義（2026-10-22 に pg_get_functiondef で読んだもの）から起こした

-- ───────────────────────────────────────────
-- 1. 設定：担当の前後の時間・時間帯を分ける空き（こども・大人で共通）
-- ───────────────────────────────────────────
alter table public.kids_shift_settings
  add column if not exists pre_minutes integer not null default 30 check (pre_minutes between 0 and 180),
  add column if not exists post_minutes integer not null default 15 check (post_minutes between 0 and 180),
  add column if not exists gap_split_minutes integer not null default 60 check (gap_split_minutes between 15 and 480);
comment on column public.kids_shift_settings.pre_minutes is '案の勤務時間：最初の担当の何分前に出勤するか';
comment on column public.kids_shift_settings.post_minutes is '案の勤務時間：最後の担当の何分後に退勤するか';
comment on column public.kids_shift_settings.gap_split_minutes is '案の勤務時間：担当の間がこの分以上空いたら、時間帯を2つに分ける（休憩もそれぞれに当てる）';

-- ───────────────────────────────────────────
-- 2. 行の種類：レッスンに数えるか
-- ───────────────────────────────────────────
alter table public.kids_shift_row_kinds
  add column if not exists counts_as_lesson boolean not null default true;
update public.kids_shift_row_kinds set counts_as_lesson = false where key in ('adult', 'pool', 'office', 'meeting', 'other');
comment on column public.kids_shift_row_kinds.counts_as_lesson is '週のまとめでレッスンの時間に数えるか（false＝レッスン以外）';

-- ───────────────────────────────────────────
-- 3. 目標の時間（決定済みの表のぶん・人ごと。行が無い正社員は40時間）
-- ───────────────────────────────────────────
create table if not exists public.kids_shift_person_targets (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  weekly_minutes integer not null check (weekly_minutes between 60 and 4800),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table public.kids_shift_person_targets enable row level security;
create policy kids_shift_person_targets_select on public.kids_shift_person_targets for select to authenticated
  using ((select public.can_manage_admin_tab('shift_patterns')));
create policy kids_shift_person_targets_insert on public.kids_shift_person_targets for insert to authenticated
  with check ((select public.can_manage_admin_tab('shift_patterns')));
create policy kids_shift_person_targets_update on public.kids_shift_person_targets for update to authenticated
  using ((select public.can_manage_admin_tab('shift_patterns'))) with check ((select public.can_manage_admin_tab('shift_patterns')));
create policy kids_shift_person_targets_delete on public.kids_shift_person_targets for delete to authenticated
  using ((select public.can_manage_admin_tab('shift_patterns')));
revoke all on public.kids_shift_person_targets from anon;
grant select, insert, update, delete on public.kids_shift_person_targets to authenticated;
grant all on public.kids_shift_person_targets to service_role;

-- ───────────────────────────────────────────
-- 4. 仮の人（表ごと。仮1・仮2…）
-- ───────────────────────────────────────────
create table if not exists public.kids_shift_temps (
  id uuid primary key default gen_random_uuid(),
  board text not null check (board in ('kids', 'adult')),
  label text not null check (length(btrim(label)) between 1 and 20),
  note text check (note is null or length(note) <= 100),
  created_by uuid,
  created_at timestamptz not null default now(),
  unique (board, label)
);
alter table public.kids_shift_temps enable row level security;
create policy kids_shift_temps_select on public.kids_shift_temps for select to authenticated
  using ((select public.can_manage_admin_tab('shift_patterns')));
create policy kids_shift_temps_insert on public.kids_shift_temps for insert to authenticated
  with check ((select public.can_manage_admin_tab('shift_patterns')));
create policy kids_shift_temps_update on public.kids_shift_temps for update to authenticated
  using ((select public.can_manage_admin_tab('shift_patterns'))) with check ((select public.can_manage_admin_tab('shift_patterns')));
create policy kids_shift_temps_delete on public.kids_shift_temps for delete to authenticated
  using ((select public.can_manage_admin_tab('shift_patterns')));
revoke all on public.kids_shift_temps from anon;
grant select, insert, update, delete on public.kids_shift_temps to authenticated;
grant all on public.kids_shift_temps to service_role;

-- マスの人に仮の人を入れられるようにする（user_id か temp_id のどちらか1つ）
-- 🚨 仮の人を消すときは、どのマスにも入っていないこと（restrict・黙ってマスから人が消えないように）
alter table public.kids_shift_item_people
  alter column user_id drop not null,
  add column if not exists temp_id uuid references public.kids_shift_temps(id) on delete restrict;
alter table public.kids_shift_item_people
  drop constraint if exists kids_shift_item_people_one_person,
  add constraint kids_shift_item_people_one_person check (num_nonnulls(user_id, temp_id) = 1);
create unique index if not exists kids_shift_item_people_temp_role_key
  on public.kids_shift_item_people (item_id, temp_id, role) where temp_id is not null;
create index if not exists kids_shift_item_people_temp_idx on public.kids_shift_item_people (temp_id) where temp_id is not null;

-- 🚨 仮の人は作業中の案のマスにだけ（決定済みの表に入らないように・決定の関数を通らない書き込みも止める）
create or replace function public.kids_shift_item_people_temp_guard()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
declare
  v_plan_cell uuid;
  v_board text;
begin
  if new.temp_id is null then
    return new;
  end if;
  select i.plan_cell_id into v_plan_cell from public.kids_shift_items i where i.id = new.item_id;
  if v_plan_cell is null then
    raise exception '仮の人は、作業中の案の中だけに入れられます（決定する前に、入社した人に置き換えてください）' using errcode = '22023';
  end if;
  select p.board into v_board
    from public.kids_shift_plan_cells pc join public.kids_shift_plans p on p.id = pc.plan_id
   where pc.id = v_plan_cell;
  if not exists (select 1 from public.kids_shift_temps t where t.id = new.temp_id and t.board = v_board) then
    raise exception '仮の人が見つかりません（ほかの表の仮の人か、消された可能性があります）' using errcode = 'P0002';
  end if;
  return new;
end;
$$;
revoke execute on function public.kids_shift_item_people_temp_guard() from public, anon, authenticated;
drop trigger if exists kids_shift_item_people_temp_guard on public.kids_shift_item_people;
create trigger kids_shift_item_people_temp_guard
  before insert or update of temp_id, item_id on public.kids_shift_item_people
  for each row execute function public.kids_shift_item_people_temp_guard();

-- ───────────────────────────────────────────
-- 5. 案の中だけの前提（人ごと・人と曜日ごと）。書くのは kids_shift_plan_save（op='terms'）だけ
-- ───────────────────────────────────────────
create table if not exists public.kids_shift_plan_people (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.kids_shift_plans(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  temp_id uuid references public.kids_shift_temps(id) on delete cascade,
  weekly_off integer check (weekly_off is null or weekly_off between 0 and 6),
  weekly_minutes integer check (weekly_minutes is null or weekly_minutes between 60 and 4800),
  daily_minutes integer check (daily_minutes is null or daily_minutes between 30 and 960),
  keep boolean not null default false,
  keep_reason text check (keep_reason is null or length(keep_reason) <= 100),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  constraint kids_shift_plan_people_one_person check (num_nonnulls(user_id, temp_id) = 1)
);
create unique index if not exists kids_shift_plan_people_user_key on public.kids_shift_plan_people (plan_id, user_id) where user_id is not null;
create unique index if not exists kids_shift_plan_people_temp_key on public.kids_shift_plan_people (plan_id, temp_id) where temp_id is not null;
alter table public.kids_shift_plan_people enable row level security;
create policy kids_shift_plan_people_select on public.kids_shift_plan_people for select to authenticated
  using ((select public.can_manage_admin_tab('shift_patterns')));
revoke all on public.kids_shift_plan_people from anon;
revoke insert, update, delete on public.kids_shift_plan_people from authenticated;  -- 書くのは kids_shift_plan_save だけ
grant select on public.kids_shift_plan_people to authenticated;
grant all on public.kids_shift_plan_people to service_role;

create table if not exists public.kids_shift_plan_person_days (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.kids_shift_plans(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  temp_id uuid references public.kids_shift_temps(id) on delete cascade,
  day_kind text not null check (day_kind in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')),
  start_time time,
  end_time time,
  office jsonb not null default '[]'::jsonb check (jsonb_typeof(office) = 'array'),
  updated_at timestamptz not null default now(),
  constraint kids_shift_plan_person_days_one_person check (num_nonnulls(user_id, temp_id) = 1),
  constraint kids_shift_plan_person_days_time check (start_time is null or end_time is null or end_time > start_time)
);
create unique index if not exists kids_shift_plan_person_days_user_key on public.kids_shift_plan_person_days (plan_id, user_id, day_kind) where user_id is not null;
create unique index if not exists kids_shift_plan_person_days_temp_key on public.kids_shift_plan_person_days (plan_id, temp_id, day_kind) where temp_id is not null;
alter table public.kids_shift_plan_person_days enable row level security;
create policy kids_shift_plan_person_days_select on public.kids_shift_plan_person_days for select to authenticated
  using ((select public.can_manage_admin_tab('shift_patterns')));
revoke all on public.kids_shift_plan_person_days from anon;
revoke insert, update, delete on public.kids_shift_plan_person_days from authenticated;
grant select on public.kids_shift_plan_person_days to authenticated;
grant all on public.kids_shift_plan_person_days to service_role;

-- ───────────────────────────────────────────
-- 6. 関数（本番の実定義から起こし、仮の人・案の前提を足した）
-- ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.kids_shift_cell_sig(p_cell_id uuid, p_plan_cell_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(md5(string_agg(line, '|' order by ord)), '')
  from (
    select i.sort_order as ord,
           i.kind_key || '/' || coalesce(to_char(i.start_time, 'HH24:MI'), '') || '-' || coalesce(to_char(i.end_time, 'HH24:MI'), '')
             || '/' || coalesce(i.class_name, '') || '/' || coalesce(i.groups::text, '') || '/' || coalesce(i.required::text, '')
             || '/' || coalesce(i.min_lesson::text, '') || '/' || coalesce(i.role_key, '') || '/' || i.is_none::text
             || '/' || coalesce(i.note, '') || '/' ||
             coalesce((select string_agg(coalesce(pe.user_id::text, 'temp:' || pe.temp_id::text) || ':' || pe.role || ':' ||
                                         coalesce(to_char(pe.start_time, 'HH24:MI'), '') || '-' ||
                                         coalesce(to_char(pe.end_time, 'HH24:MI'), ''), ',' order by pe.sort_order)
                         from public.kids_shift_item_people pe where pe.item_id = i.id), '')
             -- 🚨 2026-10-06 追加。値が無いときは何も足さない（今の署名を変えないため）。payload_sig と同じ形にすること
             || case when i.split_time is not null or i.video is not null or i.use_pool
                     then '/+' || coalesce(to_char(i.split_time, 'HH24:MI'), '') || ':' || coalesce(i.video, '') || ':' || i.use_pool::text
                     else '' end
             -- 🚨 2026-10-14 追加。行き先があるときだけ足す（今の署名を変えないため）。payload_sig と同じ形にすること
             || case when i.trip_location_id is not null then '/@' || i.trip_location_id::text else '' end as line
      from public.kids_shift_items i
     where (p_cell_id is not null and i.cell_id = p_cell_id)
        or (p_plan_cell_id is not null and i.plan_cell_id = p_plan_cell_id)
  ) x;
$function$;

CREATE OR REPLACE FUNCTION public.kids_shift_payload_sig(p_items jsonb)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
           coalesce((select string_agg(coalesce(nullif(y.value->>'user_id', ''), 'temp:' || (y.value->>'temp_id')) || ':' || coalesce(nullif(y.value->>'role', ''), 'lead') || ':' ||
                                       coalesce(to_char(nullif(y.value->>'start', '')::time, 'HH24:MI'), '') || '-' ||
                                       coalesce(to_char(nullif(y.value->>'end', '')::time, 'HH24:MI'), ''), ',' order by y.ord)
                      from jsonb_array_elements(coalesce(x.value->'people', '[]'::jsonb)) with ordinality as y(value, ord)), '')
           -- 🚨 2026-10-06 追加。cell_sig と同じ形（値が無いときは何も足さない）
           || case when nullif(x.value->>'split_time', '') is not null or nullif(x.value->>'video', '') is not null
                        or coalesce((x.value->>'use_pool')::boolean, false)
                   then '/+' || coalesce(to_char(nullif(x.value->>'split_time', '')::time, 'HH24:MI'), '') || ':'
                        || coalesce(nullif(x.value->>'video', ''), '') || ':'
                        || coalesce((x.value->>'use_pool')::boolean, false)::text
                   else '' end
           -- 🚨 2026-10-14 追加。cell_sig と同じ形（行き先があるときだけ足す）
           || case when nullif(x.value->>'trip_location_id', '') is not null then '/@' || (x.value->>'trip_location_id') else '' end as line
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as x(value, ord)
  ) z;
$function$;

CREATE OR REPLACE FUNCTION public.kids_shift_check_items(p_items jsonb, p_board text DEFAULT 'kids'::text)
 RETURNS void
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_item jsonb;
  v_person jsonb;
  v_kind text;
  v_role text;
begin
  if p_board is null or p_board not in ('kids', 'adult') then
    raise exception '表の指定が正しくありません' using errcode = '22023';
  end if;
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
      if p_board <> 'kids' then
        raise exception '見出しの役割は、こどもシフト表だけで使えます' using errcode = '22023';
      end if;
      if not exists (select 1 from public.kids_shift_role_kinds r where r.key = coalesce(v_item->>'role_key', '')) then
        raise exception '見出しの役割が見つかりません' using errcode = 'P0002';
      end if;
    elsif v_kind = 'daynote' then
      null;  -- 曜日の書き添え（文だけ）
    elsif not exists (select 1 from public.kids_shift_row_kinds k where k.key = v_kind) then
      raise exception '行の種類「%」がありません', v_kind using errcode = 'P0002';
    elsif not exists (select 1 from public.kids_shift_row_kinds k where k.key = v_kind and p_board = any (k.boards)) then
      raise exception '行の種類「%」は、この表では使えません', v_kind using errcode = '22023';
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
    -- ── 2026-10-06 追加：前後半の境・映像（大人だけ）／共通の人で回す（こどもだけ） ──
    if coalesce(v_item->>'split_time', '') <> '' then
      if p_board <> 'adult' then
        raise exception '前半と後半の境は、大人シフト表だけで使えます' using errcode = '22023';
      end if;
      if (v_item->>'split_time') !~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' then
        raise exception '前半と後半の境は「9:30」の形で入れてください' using errcode = '22023';
      end if;
      if coalesce(v_item->>'start', '') = '' or coalesce(v_item->>'end', '') = ''
         or (v_item->>'split_time')::time <= (v_item->>'start')::time
         or (v_item->>'split_time')::time >= (v_item->>'end')::time then
        raise exception '前半と後半の境は、始まりと終わりの間の時刻にしてください' using errcode = '22023';
      end if;
    end if;
    if coalesce(v_item->>'video', '') <> '' then
      if p_board <> 'adult' then
        raise exception '映像の授業の印は、大人シフト表だけで使えます' using errcode = '22023';
      end if;
      if (v_item->>'video') not in ('first', 'second') then
        raise exception '映像の授業の指定が正しくありません' using errcode = '22023';
      end if;
    end if;
    if coalesce((v_item->>'use_pool')::boolean, false) and p_board <> 'kids' then
      raise exception '「共通」の印は、こどもシフト表だけで使えます' using errcode = '22023';
    end if;
    -- ── 2026-10-14 追加：行き先（大人の出張・こどもの園指導だけ・行き先リストの行） ──
    if coalesce(v_item->>'trip_location_id', '') <> '' then
      if not ((p_board = 'adult' and v_kind = 'trip') or (p_board = 'kids' and v_kind = 'garden')) then
        raise exception '行き先は、出張・園指導の行だけに入れられます' using errcode = '22023';
      end if;
      if (v_item->>'trip_location_id') !~ '^[0-9a-fA-F-]{36}$'
         or not exists (select 1 from public.master_options m where m.id = (v_item->>'trip_location_id')::uuid and m.category like 'trip_location_%') then
        raise exception '行き先が見つかりません（リストから消された可能性があります）' using errcode = 'P0002';
      end if;
    end if;
    if jsonb_typeof(coalesce(v_item->'people', '[]'::jsonb)) <> 'array' then
      raise exception '人の指定が正しくありません' using errcode = '22023';
    end if;
    if jsonb_array_length(coalesce(v_item->'people', '[]'::jsonb)) > 12 then
      raise exception '1つの行に入れられるのは12人までです' using errcode = '22023';
    end if;
    for v_person in select y.value from jsonb_array_elements(coalesce(v_item->'people', '[]'::jsonb)) y loop
      if jsonb_typeof(v_person) <> 'object' then
        raise exception '人の指定が正しくありません' using errcode = '22023';
      end if;
      -- 🚨 2026-10-22 追加：仮の人（temp_id）。作業中の案のマスにだけ入れられる（決定済みの表はトリガーが止める）
      if coalesce(v_person->>'temp_id', '') <> '' then
        if coalesce(v_person->>'user_id', '') <> '' or (v_person->>'temp_id') !~ '^[0-9a-fA-F-]{36}$' then
          raise exception '人の指定が正しくありません' using errcode = '22023';
        end if;
        if not exists (select 1 from public.kids_shift_temps t where t.id = (v_person->>'temp_id')::uuid and t.board = p_board) then
          raise exception '仮の人が見つかりません（消された可能性があります）' using errcode = 'P0002';
        end if;
      else
        if coalesce(v_person->>'user_id', '') !~ '^[0-9a-fA-F-]{36}$' then
          raise exception '人の指定が正しくありません' using errcode = '22023';
        end if;
        if not exists (select 1 from public.profiles p where p.id = (v_person->>'user_id')::uuid) then
          raise exception 'スタッフが見つかりません（削除された可能性があります）' using errcode = 'P0002';
        end if;
      end if;
      v_role := coalesce(nullif(v_person->>'role', ''), 'lead');
      -- 🚨 表ごとに使える役割が違う（こども：担当・（勤務中）・サポート／大人：前半・後半の担当とサポート・補助）
      if (p_board = 'kids' and v_role not in ('lead', 'onduty', 'support', 'watch'))
         or (p_board = 'adult' and v_role not in ('lead', 'support', 'second', 'second_support', 'assist', 'watch')) then
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
       <> (select count(distinct coalesce(nullif(y.value->>'user_id', ''), 'temp:' || (y.value->>'temp_id')) || ':' || coalesce(nullif(y.value->>'role', ''), 'lead'))
             from jsonb_array_elements(coalesce(v_item->'people', '[]'::jsonb)) y) then
      raise exception '同じ行に同じ人が同じ役割で2回入っています' using errcode = '22023';
    end if;
  end loop;
end;
$function$;

CREATE OR REPLACE FUNCTION public.kids_shift_put_items(p_cell_id uuid, p_plan_cell_id uuid, p_items jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
       role_key, is_none, note, sort_order, split_time, video, use_pool, trip_location_id)
    values (p_cell_id, p_plan_cell_id, v_item->>'kind',
            nullif(v_item->>'start', '')::time, nullif(v_item->>'end', '')::time,
            nullif(btrim(coalesce(v_item->>'class_name', '')), ''),
            nullif(v_item->>'groups', '')::int, nullif(v_item->>'required', '')::int,
            nullif(v_item->>'min_lesson', '')::int, nullif(v_item->>'role_key', ''),
            coalesce((v_item->>'is_none')::boolean, false),
            nullif(btrim(coalesce(v_item->>'note', '')), ''), v_ord,
            nullif(v_item->>'split_time', '')::time, nullif(v_item->>'video', ''),
            coalesce((v_item->>'use_pool')::boolean, false),
            nullif(v_item->>'trip_location_id', '')::uuid)
    returning id into v_id;
    insert into public.kids_shift_item_people (item_id, user_id, temp_id, role, start_time, end_time, sort_order)
    select v_id, nullif(y.value->>'user_id', '')::uuid, nullif(y.value->>'temp_id', '')::uuid, coalesce(nullif(y.value->>'role', ''), 'lead'),
           nullif(y.value->>'start', '')::time, nullif(y.value->>'end', '')::time, y.ord
      from jsonb_array_elements(coalesce(v_item->'people', '[]'::jsonb)) with ordinality as y(value, ord);
  end loop;
end;
$function$;

CREATE OR REPLACE FUNCTION public.kids_shift_copy_items(p_src_plan_cell uuid, p_dst_cell uuid, p_dst_plan_cell uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if p_src_plan_cell is null or num_nonnulls(p_dst_cell, p_dst_plan_cell) <> 1 then
    raise exception '写す元・写す先の指定が正しくありません' using errcode = '22023';
  end if;
  delete from public.kids_shift_items i
   where (p_dst_cell is not null and i.cell_id = p_dst_cell)
      or (p_dst_plan_cell is not null and i.plan_cell_id = p_dst_plan_cell);
  insert into public.kids_shift_items
    (cell_id, plan_cell_id, kind_key, start_time, end_time, class_name, groups, required, min_lesson,
     role_key, is_none, note, sort_order, split_time, video, use_pool, trip_location_id)
  select p_dst_cell, p_dst_plan_cell, i.kind_key, i.start_time, i.end_time, i.class_name, i.groups, i.required,
         i.min_lesson, i.role_key, i.is_none, i.note, i.sort_order, i.split_time, i.video, i.use_pool, i.trip_location_id
    from public.kids_shift_items i where i.plan_cell_id = p_src_plan_cell;
  -- 🚨 人は sort_order で新しい行と結び付ける（1つのマスの中で sort_order は重ならない）
  insert into public.kids_shift_item_people (item_id, user_id, temp_id, role, start_time, end_time, sort_order)
  select ni.id, pe.user_id, pe.temp_id, pe.role, pe.start_time, pe.end_time, pe.sort_order
    from public.kids_shift_items oi
    join public.kids_shift_item_people pe on pe.item_id = oi.id
    join public.kids_shift_items ni
      on ni.sort_order = oi.sort_order
     and ((p_dst_cell is not null and ni.cell_id = p_dst_cell)
          or (p_dst_plan_cell is not null and ni.plan_cell_id = p_dst_plan_cell))
   where oi.plan_cell_id = p_src_plan_cell;
end;
$function$;

CREATE OR REPLACE FUNCTION public.kids_shift_plan_save(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_op text;
  v_board text;
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
  -- 2026-10-22 追加：案の前提（terms）・仮の人の置き換え（assign_temp）
  v_person jsonb;
  v_day_row jsonb;
  v_seg jsonb;
  v_uid uuid;
  v_tid uuid;
  v_count integer := 0;
  v_people_keep boolean;
begin
  if not public.can_manage_admin_tab('shift_patterns') then
    raise exception 'シフト表の案を保存する権限がありません' using errcode = '42501';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception '保存する内容がありません' using errcode = '22023';
  end if;
  v_op := coalesce(p_payload->>'op', '');
  if v_op not in ('create', 'update', 'cells', 'archive', 'terms', 'assign_temp') then
    raise exception '案の操作の指定が正しくありません' using errcode = '22023';
  end if;

  -- どの表か：作るときは payload の board（既定 'kids'）、それ以外は案の board（🚨 payload の board は見ない）
  if v_op = 'create' then
    v_board := coalesce(nullif(p_payload->>'board', ''), 'kids');
    if v_board not in ('kids', 'adult') then
      raise exception '表の指定が正しくありません' using errcode = '22023';
    end if;
  else
    if coalesce(p_payload->>'plan_id', '') !~ '^[0-9a-fA-F-]{36}$' then
      raise exception '案の指定が正しくありません' using errcode = '22023';
    end if;
    select p.board into v_board from public.kids_shift_plans p where p.id = (p_payload->>'plan_id')::uuid;
    if v_board is null then
      raise exception '案が見つかりません（ほかの人が消した可能性があります）' using errcode = 'P0002';
    end if;
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
      -- 🚨 こどもの案に大人の置き場所を入れない（その逆も）
      if not exists (select 1 from public.kids_shift_places p where p.id = (v_cell->>'place_id')::uuid and p.board = v_board) then
        raise exception 'ほかの表の置き場所が入っています' using errcode = '22023';
      end if;
      if coalesce(v_cell->>'day_kind', '') not in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun') then
        raise exception '曜日の指定が正しくありません' using errcode = '22023';
      end if;
      perform public.kids_shift_check_items(v_cell->'items', v_board);
    end loop;
  end if;

  perform pg_advisory_xact_lock(hashtext('kids_shift_save'));

  -- ── 作る（写して作ることもできる） ──
  if v_op = 'create' then
    select coalesce(s.plan_limit, 10) into v_limit from public.kids_shift_settings s where s.id;
    -- 🚨 上限は表ごとに数える（大人の案でこどもの案が作れなくならないように）
    select count(*) into v_open_count from public.kids_shift_plans p where p.status = 'open' and p.board = v_board;
    if v_open_count >= coalesce(v_limit, 10) then
      return jsonb_build_object('ok', false, 'reason', 'plan_limit', 'limit', coalesce(v_limit, 10));
    end if;

    if coalesce(p_payload->>'copy_from', '') <> '' then
      select * into v_src from public.kids_shift_plans p where p.id = (p_payload->>'copy_from')::uuid;
      if not found then
        raise exception '写す元の案が見つかりません' using errcode = 'P0002';
      end if;
      if v_src.board <> v_board then
        raise exception 'ほかの表の案からは写せません' using errcode = '22023';
      end if;
    end if;

    insert into public.kids_shift_plans (name, apply_from, board, created_by, updated_by)
    values (btrim(p_payload->>'name'), (p_payload->>'apply_from')::date, v_board, auth.uid(), auth.uid())
    returning id into v_id;

    if coalesce(p_payload->>'copy_from', '') <> '' then
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
        perform public.kids_shift_copy_items(v_item.src_pc, null, v_pc);
      end loop;
      -- 🚨 2026-10-22 追加：案の前提（人ごと・人と曜日ごと）も写す
      insert into public.kids_shift_plan_people (plan_id, user_id, temp_id, weekly_off, weekly_minutes, daily_minutes, keep, keep_reason, updated_by)
      select v_id, pp.user_id, pp.temp_id, pp.weekly_off, pp.weekly_minutes, pp.daily_minutes, pp.keep, pp.keep_reason, auth.uid()
        from public.kids_shift_plan_people pp where pp.plan_id = v_src.id;
      insert into public.kids_shift_plan_person_days (plan_id, user_id, temp_id, day_kind, start_time, end_time, office)
      select v_id, d.user_id, d.temp_id, d.day_kind, d.start_time, d.end_time, d.office
        from public.kids_shift_plan_person_days d where d.plan_id = v_src.id;
    end if;

    select * into v_plan from public.kids_shift_plans p where p.id = v_id;
    return jsonb_build_object('ok', true, 'plan_id', v_id, 'revision', v_plan.revision);
  end if;

  -- ── ここから先は案を指定する操作 ──
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

  -- ── 案の前提（2026-10-22）：人ごとに丸ごと入れ替える。全部空で「まとめて変えない」でもなければ行を消す（＝自動の値に戻す） ──
  if v_op = 'terms' then
    if jsonb_typeof(p_payload->'people') is distinct from 'array' or jsonb_array_length(p_payload->'people') = 0 then
      raise exception '保存する前提がありません' using errcode = '22023';
    end if;
    if jsonb_array_length(p_payload->'people') > 200 then
      raise exception '一度に保存できるのは200人までです' using errcode = '22023';
    end if;
    for v_person in select x.value from jsonb_array_elements(p_payload->'people') x loop
      v_uid := null; v_tid := null;
      if jsonb_typeof(v_person) <> 'object' then
        raise exception '人の指定が正しくありません' using errcode = '22023';
      end if;
      if coalesce(v_person->>'temp_id', '') <> '' then
        if (v_person->>'temp_id') !~ '^[0-9a-fA-F-]{36}$' then
          raise exception '人の指定が正しくありません' using errcode = '22023';
        end if;
        v_tid := (v_person->>'temp_id')::uuid;
        if not exists (select 1 from public.kids_shift_temps t where t.id = v_tid and t.board = v_board) then
          raise exception '仮の人が見つかりません（消された可能性があります）' using errcode = 'P0002';
        end if;
      else
        if coalesce(v_person->>'user_id', '') !~ '^[0-9a-fA-F-]{36}$' then
          raise exception '人の指定が正しくありません' using errcode = '22023';
        end if;
        v_uid := (v_person->>'user_id')::uuid;
        if not exists (select 1 from public.profiles p where p.id = v_uid) then
          raise exception 'スタッフが見つかりません（削除された可能性があります）' using errcode = 'P0002';
        end if;
      end if;
      if coalesce(v_person->>'weekly_off', '') <> '' and ((v_person->>'weekly_off') !~ '^[0-6]$') then
        raise exception '週休は0〜6日で入れてください' using errcode = '22023';
      end if;
      if coalesce(v_person->>'weekly_minutes', '') <> ''
         and ((v_person->>'weekly_minutes') !~ '^[0-9]{1,4}$' or (v_person->>'weekly_minutes')::int not between 60 and 4800) then
        raise exception '週の目標時間は1〜80時間で入れてください' using errcode = '22023';
      end if;
      if coalesce(v_person->>'daily_minutes', '') <> ''
         and ((v_person->>'daily_minutes') !~ '^[0-9]{1,4}$' or (v_person->>'daily_minutes')::int not between 30 and 960) then
        raise exception '1日の目安は0:30〜16:00で入れてください' using errcode = '22023';
      end if;
      if length(coalesce(v_person->>'keep_reason', '')) > 100 then
        raise exception 'まとめて変えない理由は100文字までです' using errcode = '22023';
      end if;
      v_people_keep := coalesce((v_person->>'keep')::boolean, false);

      delete from public.kids_shift_plan_people pp
       where pp.plan_id = v_plan.id and ((v_uid is not null and pp.user_id = v_uid) or (v_tid is not null and pp.temp_id = v_tid));
      if coalesce(v_person->>'weekly_off', '') <> '' or coalesce(v_person->>'weekly_minutes', '') <> ''
         or coalesce(v_person->>'daily_minutes', '') <> '' or v_people_keep then
        insert into public.kids_shift_plan_people (plan_id, user_id, temp_id, weekly_off, weekly_minutes, daily_minutes, keep, keep_reason, updated_by)
        values (v_plan.id, v_uid, v_tid, nullif(v_person->>'weekly_off', '')::int, nullif(v_person->>'weekly_minutes', '')::int,
                nullif(v_person->>'daily_minutes', '')::int, v_people_keep,
                case when v_people_keep then nullif(btrim(coalesce(v_person->>'keep_reason', '')), '') else null end, auth.uid());
      end if;

      -- 曜日ごと（出勤・退勤の時刻・事務の時間）。days を送ったときだけ、その人の分を丸ごと入れ替える
      if v_person ? 'days' then
        if jsonb_typeof(v_person->'days') <> 'array' or jsonb_array_length(v_person->'days') > 7 then
          raise exception '曜日の指定が正しくありません' using errcode = '22023';
        end if;
        delete from public.kids_shift_plan_person_days d
         where d.plan_id = v_plan.id and ((v_uid is not null and d.user_id = v_uid) or (v_tid is not null and d.temp_id = v_tid));
        for v_day_row in select y.value from jsonb_array_elements(v_person->'days') y loop
          if jsonb_typeof(v_day_row) <> 'object' or coalesce(v_day_row->>'day_kind', '') not in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun') then
            raise exception '曜日の指定が正しくありません' using errcode = '22023';
          end if;
          if (coalesce(v_day_row->>'start', '') <> '' and (v_day_row->>'start') !~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$')
             or (coalesce(v_day_row->>'end', '') <> '' and (v_day_row->>'end') !~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$') then
            raise exception '出勤・退勤の時刻は「9:30」の形で入れてください' using errcode = '22023';
          end if;
          if coalesce(v_day_row->>'start', '') <> '' and coalesce(v_day_row->>'end', '') <> ''
             and (v_day_row->>'end')::time <= (v_day_row->>'start')::time then
            raise exception '退勤は出勤より後にしてください' using errcode = '22023';
          end if;
          if jsonb_typeof(coalesce(v_day_row->'office', '[]'::jsonb)) <> 'array' or jsonb_array_length(coalesce(v_day_row->'office', '[]'::jsonb)) > 6 then
            raise exception '事務の時間は1日6つまでです' using errcode = '22023';
          end if;
          for v_seg in select z.value from jsonb_array_elements(coalesce(v_day_row->'office', '[]'::jsonb)) z loop
            if jsonb_typeof(v_seg) <> 'object'
               or coalesce(v_seg->>'start', '') !~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$'
               or coalesce(v_seg->>'end', '') !~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$'
               or (v_seg->>'end')::time <= (v_seg->>'start')::time then
              raise exception '事務の時間は「13:00〜16:00」の形で、終わりを始まりより後にしてください' using errcode = '22023';
            end if;
          end loop;
          if coalesce(v_day_row->>'start', '') = '' and coalesce(v_day_row->>'end', '') = ''
             and jsonb_array_length(coalesce(v_day_row->'office', '[]'::jsonb)) = 0 then
            continue;
          end if;
          insert into public.kids_shift_plan_person_days (plan_id, user_id, temp_id, day_kind, start_time, end_time, office)
          values (v_plan.id, v_uid, v_tid, v_day_row->>'day_kind', nullif(v_day_row->>'start', '')::time, nullif(v_day_row->>'end', '')::time,
                  (select coalesce(jsonb_agg(jsonb_build_object('start', to_char((z.value->>'start')::time, 'HH24:MI'), 'end', to_char((z.value->>'end')::time, 'HH24:MI'))
                                             order by (z.value->>'start')::time), '[]'::jsonb)
                     from jsonb_array_elements(coalesce(v_day_row->'office', '[]'::jsonb)) z));
        end loop;
      end if;
      v_count := v_count + 1;
    end loop;

    update public.kids_shift_plans
       set revision = revision + 1, updated_by = auth.uid(), updated_at = now()
     where id = v_plan.id;
    return jsonb_build_object('ok', true, 'revision', v_plan.revision + 1, 'people', v_count);
  end if;

  -- ── 仮の人を入社した人に置き換える（2026-10-22）。この案のマスと前提だけ ──
  if v_op = 'assign_temp' then
    if coalesce(p_payload->>'temp_id', '') !~ '^[0-9a-fA-F-]{36}$' or coalesce(p_payload->>'user_id', '') !~ '^[0-9a-fA-F-]{36}$' then
      raise exception '人の指定が正しくありません' using errcode = '22023';
    end if;
    v_tid := (p_payload->>'temp_id')::uuid;
    v_uid := (p_payload->>'user_id')::uuid;
    if not exists (select 1 from public.kids_shift_temps t where t.id = v_tid and t.board = v_board) then
      raise exception '仮の人が見つかりません（消された可能性があります）' using errcode = 'P0002';
    end if;
    if not exists (select 1 from public.profiles p where p.id = v_uid) then
      raise exception 'スタッフが見つかりません（削除された可能性があります）' using errcode = 'P0002';
    end if;
    if exists (
      select 1
        from public.kids_shift_item_people a
        join public.kids_shift_item_people b on b.item_id = a.item_id and b.role = a.role and b.user_id = v_uid
        join public.kids_shift_items i on i.id = a.item_id
        join public.kids_shift_plan_cells pc on pc.id = i.plan_cell_id
       where pc.plan_id = v_plan.id and a.temp_id = v_tid
    ) then
      raise exception '同じ行に、その方がすでに同じ役割で入っています。先にどちらかを外してください' using errcode = '22023';
    end if;
    update public.kids_shift_item_people pe
       set user_id = v_uid, temp_id = null
      from public.kids_shift_items i
      join public.kids_shift_plan_cells pc on pc.id = i.plan_cell_id
     where pe.item_id = i.id and pc.plan_id = v_plan.id and pe.temp_id = v_tid;
    get diagnostics v_count = row_count;
    -- 前提：その方の前提がすでにあればそちらを残す（仮の人の分は消す）
    if exists (select 1 from public.kids_shift_plan_people pp where pp.plan_id = v_plan.id and pp.user_id = v_uid) then
      delete from public.kids_shift_plan_people pp where pp.plan_id = v_plan.id and pp.temp_id = v_tid;
    else
      update public.kids_shift_plan_people pp set user_id = v_uid, temp_id = null, updated_by = auth.uid(), updated_at = now()
       where pp.plan_id = v_plan.id and pp.temp_id = v_tid;
    end if;
    delete from public.kids_shift_plan_person_days d
     where d.plan_id = v_plan.id and d.temp_id = v_tid
       and exists (select 1 from public.kids_shift_plan_person_days u where u.plan_id = v_plan.id and u.user_id = v_uid and u.day_kind = d.day_kind);
    update public.kids_shift_plan_person_days d set user_id = v_uid, temp_id = null, updated_at = now()
     where d.plan_id = v_plan.id and d.temp_id = v_tid;

    update public.kids_shift_plans
       set revision = revision + 1, updated_by = auth.uid(), updated_at = now()
     where id = v_plan.id;
    return jsonb_build_object('ok', true, 'revision', v_plan.revision + 1, 'replaced', v_count);
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
$function$;

CREATE OR REPLACE FUNCTION public.kids_shift_plan_decide(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  v_temps integer := 0;
begin
  if not public.can_manage_admin_tab('shift_patterns') then
    raise exception 'シフト表を決定する権限がありません' using errcode = '42501';
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
  -- 🚨 比べるのは案の表の token（大人の案を決めるときに、こどもの保存で止まらない）
  if coalesce(p_payload->>'base_token', '') <> public.kids_shift_token(v_plan.board) then
    return jsonb_build_object('ok', false, 'reason', 'stale');
  end if;
  if v_from < v_today and coalesce((p_payload->>'confirm_past')::boolean, false) is not true then
    return jsonb_build_object('ok', false, 'reason', 'past_confirm');
  end if;
  -- 🚨 2026-10-22 追加：仮の人が残っている案は決定しない（入社した人に置き換えてから）
  select count(*) into v_temps
    from public.kids_shift_item_people pe
    join public.kids_shift_items i on i.id = pe.item_id
    join public.kids_shift_plan_cells pc on pc.id = i.plan_cell_id
   where pc.plan_id = v_plan.id and pe.temp_id is not null;
  if v_temps > 0 then
    return jsonb_build_object('ok', false, 'reason', 'temps', 'count', v_temps);
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
    perform public.kids_shift_copy_items(v_pc.id, (v_open->>'cell_id')::uuid, null);
    v_changed := v_changed + 1;
  end loop;

  update public.kids_shift_plans
     set status = 'archived', archived_reason = 'decided', archived_at = now(), decided_from = v_from,
         revision = revision + 1, updated_by = auth.uid(), updated_at = now()
   where id = v_plan.id;

  return jsonb_build_object('ok', true, 'changed', v_changed, 'unchanged', v_unchanged,
                            'skipped', v_skipped, 'kept_future', v_kept);
end;
$function$;

-- 権限は今までどおり（作り直しても変わらないことを適用後に has_function_privilege で確かめる）
revoke execute on function public.kids_shift_cell_sig(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.kids_shift_payload_sig(jsonb) from public, anon, authenticated;
revoke execute on function public.kids_shift_put_items(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.kids_shift_copy_items(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.kids_shift_check_items(jsonb, text) from public, anon, authenticated;
revoke execute on function public.kids_shift_plan_save(jsonb) from public, anon;
revoke execute on function public.kids_shift_plan_decide(jsonb) from public, anon;
grant execute on function public.kids_shift_plan_save(jsonb) to authenticated;
grant execute on function public.kids_shift_plan_decide(jsonb) to authenticated;
