-- シフト管理（② 勤務表の一括編集）2026-09-15
-- 設計・決めたことは docs/計画-管理画面の開放.md の 5-1〜5-3。
--
-- ・部門の一覧（shift_work_areas）とメインの部門（staff_main_work_areas）。受理の宛先に使う所属チーム（group_names）とは別
-- ・weekly_shift_patterns に segments（1日の中の「時間・校・部門」の区切り）・note（曜日ごとの書き添え）・saved_by を足す
--   🚨 既存の列（start_time … location・break_minutes・labor_minutes）は、読む側（画面7か所・sync_overtime_from_leave）のために
--      保存の関数が segments から作って書く。書くのは関数だけなので2か所の食い違いは起きない
-- ・人ごとの書き添え（weekly_shift_person_notes）。シフトと同じく「いつから」で切り替わる
-- ・休憩・労働時間の計算を SQL にも持つ（lib/breakCalc.ts の calcSegmentBreak の写し。🚨 あちらを直したらこちらも直す）
-- ・一括保存の関数 shift_patterns_save：
--     変えた人・変えた曜日だけ新しい版／先に登録してある版は残して前日までにする／今日より前は確認つき／
--     開いた時点の目印が違えば断る（stale）／途中で失敗したら何も残さない
-- ・読み：シフト管理のタブが開いている人も weekly_shift_patterns を読める（書き込みの許可は広げない）

-- ───────────────────────────────────────────
-- 1. 部門
-- ───────────────────────────────────────────
create table if not exists public.shift_work_areas (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(btrim(name)) between 1 and 20),
  short_name text not null check (length(btrim(short_name)) between 1 and 4),
  color text not null default 'gray' check (color in ('teal', 'amber', 'blue', 'purple', 'coral', 'pink', 'green', 'gray')),
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.shift_work_areas is
  'シフト管理の部門（こども・大人・管理部…）。受理の宛先に使う所属チーム（profiles.group_names）とは別。消さずに active=false で隠す（2026-09-15）';

insert into public.shift_work_areas (name, short_name, color, sort_order) values
  ('こども', '子', 'teal', 1),
  ('大人', '大', 'amber', 2),
  ('管理部', '管', 'blue', 3),
  ('フロント', 'フ', 'purple', 4),
  ('事務', '事', 'pink', 5),
  ('テレワーク', 'テ', 'gray', 6)
on conflict (name) do nothing;

alter table public.shift_work_areas enable row level security;

drop policy if exists shift_work_areas_select on public.shift_work_areas;
create policy shift_work_areas_select on public.shift_work_areas
  for select to authenticated using (true);

drop policy if exists shift_work_areas_insert on public.shift_work_areas;
create policy shift_work_areas_insert on public.shift_work_areas
  for insert to authenticated with check ((select public.can_manage_admin_tab('shift_patterns')));

drop policy if exists shift_work_areas_update on public.shift_work_areas;
create policy shift_work_areas_update on public.shift_work_areas
  for update to authenticated
  using ((select public.can_manage_admin_tab('shift_patterns')))
  with check ((select public.can_manage_admin_tab('shift_patterns')));

-- ───────────────────────────────────────────
-- 2. メインの部門（1人1つ）
-- ───────────────────────────────────────────
create table if not exists public.staff_main_work_areas (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  area_id uuid not null references public.shift_work_areas(id),
  updated_at timestamptz not null default now(),
  updated_by uuid
);

comment on table public.staff_main_work_areas is
  'スタッフのメインの部門（1人1つ）。PDF・絞り込みの並びに使う。書くのは shift_patterns_save だけ（2026-09-15）';

-- 最初は所属チーム（こども・大人・管理部）と同じ名前の部門を入れておく（画面で直せる）
insert into public.staff_main_work_areas (user_id, area_id)
select p.id, a.id
from public.profiles p
cross join lateral (
  select g from unnest(coalesce(p.group_names, '{}'::text[])) g
  where g in (select mo.value from public.master_options mo where mo.category = 'shift_report_group')
  limit 1
) t
join public.shift_work_areas a on a.name = t.g
where p.is_active
on conflict (user_id) do nothing;

alter table public.staff_main_work_areas enable row level security;

drop policy if exists staff_main_work_areas_select on public.staff_main_work_areas;
create policy staff_main_work_areas_select on public.staff_main_work_areas
  for select to authenticated using (true);

-- ───────────────────────────────────────────
-- 3. weekly_shift_patterns に列を足す
-- ───────────────────────────────────────────
alter table public.weekly_shift_patterns add column if not exists segments jsonb;
alter table public.weekly_shift_patterns add column if not exists note text;
alter table public.weekly_shift_patterns add column if not exists saved_by uuid;

comment on column public.weekly_shift_patterns.segments is
  '1日の中の区切り [{start:"HH:MM", end:"HH:MM", location:"四条本校", area_id:uuid|null}]（時刻順）。area_id=null はメインの部門。休みは []。書くのは shift_patterns_save だけ（2026-09-15）';
comment on column public.weekly_shift_patterns.note is '曜日ごとの書き添え（勤務表のマスの下に印刷）';
comment on column public.weekly_shift_patterns.saved_by is '最後に保存した人（shift_patterns_save）';

do $$ begin
  alter table public.weekly_shift_patterns
    add constraint weekly_shift_patterns_segments_array check (segments is null or jsonb_typeof(segments) = 'array');
exception when duplicate_object then null;
end $$;

-- 今までの列から segments を作る（読む側・保存の関数が同じ形で比べられるように）
create or replace function public.shift_legacy_segments(
  p_start time, p_end time, p_start2 time, p_end2 time, p_location text
) returns jsonb
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(jsonb_agg(b.seg order by b.st), '[]'::jsonb)
  from (
    select p_start as st,
           jsonb_build_object('start', to_char(p_start, 'HH24:MI'), 'end', to_char(p_end, 'HH24:MI'),
                              'location', p_location, 'area_id', null) as seg
     where p_start is not null and p_end is not null
    union all
    select p_start2,
           jsonb_build_object('start', to_char(p_start2, 'HH24:MI'), 'end', to_char(p_end2, 'HH24:MI'),
                              'location', p_location, 'area_id', null)
     where p_start2 is not null and p_end2 is not null
  ) b;
$$;

revoke execute on function public.shift_legacy_segments(time, time, time, time, text) from public;
revoke execute on function public.shift_legacy_segments(time, time, time, time, text) from anon;
grant execute on function public.shift_legacy_segments(time, time, time, time, text) to authenticated;

update public.weekly_shift_patterns
   set segments = public.shift_legacy_segments(start_time, end_time, start_time2, end_time2, location)
 where segments is null;

-- シフト管理のタブが開いている人も読める（書き込みは広げない。書くのは関数だけ）
drop policy if exists patterns_select_shift_admin_tab on public.weekly_shift_patterns;
create policy patterns_select_shift_admin_tab on public.weekly_shift_patterns
  for select to authenticated using ((select public.can_manage_admin_tab('shift_patterns')));

-- ───────────────────────────────────────────
-- 4. 人ごとの書き添え
-- ───────────────────────────────────────────
create table if not exists public.weekly_shift_person_notes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  note text not null check (length(btrim(note)) between 1 and 200),
  valid_from date not null,
  valid_to date,
  saved_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint weekly_shift_person_notes_range check (valid_to is null or valid_to >= valid_from),
  constraint weekly_shift_person_notes_no_overlap
    exclude using gist (user_id with =, daterange(valid_from, valid_to, '[]') with &&)
);

comment on table public.weekly_shift_person_notes is
  '勤務表の人ごとの書き添え（「月1(木)下鴨夢 10:00～12:00」など）。シフトと同じく valid_from/valid_to で切り替わる。書くのは shift_patterns_save だけ（2026-09-15）';

drop trigger if exists weekly_shift_person_notes_updated_at on public.weekly_shift_person_notes;
create trigger weekly_shift_person_notes_updated_at
  before update on public.weekly_shift_person_notes
  for each row execute function public.set_updated_at();

alter table public.weekly_shift_person_notes enable row level security;

drop policy if exists weekly_shift_person_notes_select on public.weekly_shift_person_notes;
create policy weekly_shift_person_notes_select on public.weekly_shift_person_notes
  for select to authenticated
  using (user_id = (select auth.uid()) or (select public.can_manage_admin_tab('shift_patterns')));

-- ───────────────────────────────────────────
-- 5. 休憩・労働時間の計算（lib/breakCalc.ts の写し）
-- ───────────────────────────────────────────
-- 🚨 calcSegmentBreak と同じ表。あちらを直したら必ずこちらも直す
create or replace function public.shift_band_break(p_start integer, p_end integer)
returns integer
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    -- 🚨 時間帯が無い（null）ときは 0。これが無いと下の「その他」に落ちて 60分になる（リハーサルで見つけた）
    when p_start is null or p_end is null then 0
    when p_end - p_start <= 0 then 0
    when p_start < 13 * 60 then
      case when p_end - p_start < 255 then 0
           when p_end - p_start <= 390 then 30
           when p_end - p_start <= 525 then 45
           else 60 end
    else
      case when p_end - p_start <= 345 then 0
           when p_end - p_start <= 375 then 15
           when p_end - p_start <= 390 then 30
           when p_end - p_start <= 525 then 45
           else 60 end
  end;
$$;

revoke execute on function public.shift_band_break(integer, integer) from public;
revoke execute on function public.shift_band_break(integer, integer) from anon;
grant execute on function public.shift_band_break(integer, integer) to authenticated;

-- segments から、今までの列（時間帯2つ・校・休憩・労働）を作る。形がおかしければ理由つきで断る。
-- ・つながっている区切り（前の終わり＝次の始まり）は1つの時間帯にまとめ、校は「四条本校→西陣校」とつなぐ
-- ・時間帯は2つまで（今の列が2つのため）。本務（band1）は長いほう、同じ長さなら早いほう
create or replace function public.shift_pattern_fields(p_segments jsonb)
returns table (
  start_time time, end_time time, start_time2 time, end_time2 time,
  location text, break_minutes integer, labor_minutes integer
)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  v_seg jsonb;
  v_prev_end integer := null;
  v_s integer;
  v_e integer;
  v_loc text;
  v_bands jsonb := '[]'::jsonb;   -- [{s, e, locs:[...]}]
  v_cur_s integer := null;
  v_cur_e integer := null;
  v_cur_locs text[] := '{}';
  v_b1 jsonb;
  v_b2 jsonb;
  v_n integer;
  v_part text;
begin
  if p_segments is null or jsonb_typeof(p_segments) <> 'array' then
    raise exception '時間帯の形が正しくありません' using errcode = '22023';
  end if;

  -- 🚨 並べ替える前に形を確かめる（並べ替えで数に直すので、形が崩れていると理由の分からないエラーで止まる）
  for v_seg in select x.value from jsonb_array_elements(p_segments) x loop
    if jsonb_typeof(v_seg) <> 'object'
       or coalesce(v_seg->>'start', '') !~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$'
       or coalesce(v_seg->>'end', '') !~ '^([01]?[0-9]|2[0-4]):[0-5][0-9]$' then
      raise exception '時刻は「9:30」の形で入れてください' using errcode = '22023';
    end if;
  end loop;

  for v_seg in
    select x.value from jsonb_array_elements(p_segments) x
    order by (split_part(x.value->>'start', ':', 1))::int * 60 + (split_part(x.value->>'start', ':', 2))::int
  loop
    if coalesce(v_seg->>'start', '') !~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$'
       or coalesce(v_seg->>'end', '') !~ '^([01]?[0-9]|2[0-4]):[0-5][0-9]$' then
      raise exception '時刻は「9:30」の形で入れてください' using errcode = '22023';
    end if;
    v_s := split_part(v_seg->>'start', ':', 1)::int * 60 + split_part(v_seg->>'start', ':', 2)::int;
    v_e := split_part(v_seg->>'end', ':', 1)::int * 60 + split_part(v_seg->>'end', ':', 2)::int;
    if v_e <= v_s or v_e > 1440 then
      raise exception '終わりの時刻は始まりより後にしてください（%〜%）', v_seg->>'start', v_seg->>'end' using errcode = '22023';
    end if;
    if v_prev_end is not null and v_s < v_prev_end then
      raise exception '時間帯が重なっています（%〜%）', v_seg->>'start', v_seg->>'end' using errcode = '22023';
    end if;

    v_loc := nullif(btrim(coalesce(v_seg->>'location', '')), '');
    if v_loc is null then
      raise exception '校を選んでください（%〜%）', v_seg->>'start', v_seg->>'end' using errcode = '22023';
    end if;
    foreach v_part in array string_to_array(v_loc, '→') loop
      if not exists (select 1 from public.master_options mo where mo.category = 'workplace' and mo.value = btrim(v_part)) then
        raise exception '「%」という校はありません', v_part using errcode = '22023';
      end if;
    end loop;
    if nullif(v_seg->>'area_id', '') is not null
       and not exists (select 1 from public.shift_work_areas a where a.id::text = v_seg->>'area_id') then
      raise exception '部門が見つかりません' using errcode = '22023';
    end if;

    if v_cur_s is not null and v_s = v_cur_e then
      v_cur_e := v_e;
    else
      if v_cur_s is not null then
        v_bands := v_bands || jsonb_build_object('s', v_cur_s, 'e', v_cur_e, 'locs', to_jsonb(v_cur_locs));
      end if;
      v_cur_s := v_s; v_cur_e := v_e; v_cur_locs := '{}';
    end if;
    foreach v_part in array string_to_array(v_loc, '→') loop
      if cardinality(v_cur_locs) = 0 or v_cur_locs[cardinality(v_cur_locs)] <> btrim(v_part) then
        v_cur_locs := v_cur_locs || btrim(v_part);
      end if;
    end loop;
    v_prev_end := v_e;
  end loop;

  if v_cur_s is not null then
    v_bands := v_bands || jsonb_build_object('s', v_cur_s, 'e', v_cur_e, 'locs', to_jsonb(v_cur_locs));
  end if;

  v_n := jsonb_array_length(v_bands);
  if v_n = 0 then
    return query select null::time, null::time, null::time, null::time, null::text, 0, 0;
    return;
  end if;
  if v_n > 2 then
    raise exception '1日の時間帯は2つまでです（間の空いた時間帯が%つあります）', v_n using errcode = '22023';
  end if;

  if v_n = 1 then
    v_b1 := v_bands->0; v_b2 := null;
  elsif ((v_bands->1->>'e')::int - (v_bands->1->>'s')::int) > ((v_bands->0->>'e')::int - (v_bands->0->>'s')::int) then
    v_b1 := v_bands->1; v_b2 := v_bands->0;
  else
    v_b1 := v_bands->0; v_b2 := v_bands->1;
  end if;

  return query
  select
    make_time((v_b1->>'s')::int / 60, (v_b1->>'s')::int % 60, 0),
    case when (v_b1->>'e')::int = 1440 then time '23:59' else make_time((v_b1->>'e')::int / 60, (v_b1->>'e')::int % 60, 0) end,
    case when v_b2 is null then null else make_time((v_b2->>'s')::int / 60, (v_b2->>'s')::int % 60, 0) end,
    case when v_b2 is null then null
         when (v_b2->>'e')::int = 1440 then time '23:59'
         else make_time((v_b2->>'e')::int / 60, (v_b2->>'e')::int % 60, 0) end,
    (select string_agg(l, '→') from jsonb_array_elements_text(v_b1->'locs') l),
    public.shift_band_break((v_b1->>'s')::int, (v_b1->>'e')::int)
      + coalesce(public.shift_band_break((v_b2->>'s')::int, (v_b2->>'e')::int), 0),
    ((v_b1->>'e')::int - (v_b1->>'s')::int) + coalesce((v_b2->>'e')::int - (v_b2->>'s')::int, 0)
      - public.shift_band_break((v_b1->>'s')::int, (v_b1->>'e')::int)
      - coalesce(public.shift_band_break((v_b2->>'s')::int, (v_b2->>'e')::int), 0);
end;
$$;

revoke execute on function public.shift_pattern_fields(jsonb) from public;
revoke execute on function public.shift_pattern_fields(jsonb) from anon;
grant execute on function public.shift_pattern_fields(jsonb) to authenticated;

-- ───────────────────────────────────────────
-- 6. 開いた時点の目印（別の人が先に保存していないか）
-- ───────────────────────────────────────────
create or replace function public.shift_patterns_token(p_user_ids uuid[])
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
    coalesce((select string_agg(w.id::text || w.updated_at::text || coalesce(w.valid_to::text, '-'), ',' order by w.id)
                from public.weekly_shift_patterns w where w.user_id = any(p_user_ids)), '')
    || '|' ||
    coalesce((select string_agg(n.id::text || n.updated_at::text || coalesce(n.valid_to::text, '-'), ',' order by n.id)
                from public.weekly_shift_person_notes n where n.user_id = any(p_user_ids)), '')
    || '|' ||
    coalesce((select string_agg(m.user_id::text || m.area_id::text, ',' order by m.user_id)
                from public.staff_main_work_areas m where m.user_id = any(p_user_ids)), '')
  );
end;
$$;

revoke execute on function public.shift_patterns_token(uuid[]) from public;
revoke execute on function public.shift_patterns_token(uuid[]) from anon;
grant execute on function public.shift_patterns_token(uuid[]) to authenticated;

-- ───────────────────────────────────────────
-- 7. 一括保存
-- ───────────────────────────────────────────
-- p_payload:
-- {
--   "apply_from": "2026-10-01",
--   "confirm_past": false,
--   "base_token": "…",                    -- shift_patterns_token(対象の全員) を開いたときに読んだ値
--   "people": [
--     { "user_id": "…",
--       "main_area_id": "…",               -- 任意（無ければ変えない）
--       "person_note": "月1(木)下鴨夢…",   -- 任意（キーが無ければ変えない。空文字は「書き添えなし」）
--       "days": { "mon": { "segments": [...], "note": "…" }, … }   -- 送った曜日だけ比べる
--     }, …
--   ]
-- }
-- 戻り値：{ ok, reason, changed_people, unchanged_people, rows_written, kept_future:[{user_id, day_kind, until}], main_area_changed }
--   reason … 'past_confirm'（今日より前で確認なし）／'stale'（開いたあとに別の人が保存した）
create or replace function public.shift_patterns_save(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_from date;
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_people jsonb;
  v_person jsonb;
  v_user uuid;
  v_ids uuid[];
  v_name text;
  v_day text;
  v_day_val jsonb;
  v_new_segs jsonb;
  v_new_note text;
  v_cur public.weekly_shift_patterns%rowtype;
  v_cur_segs jsonb;
  v_next date;
  v_to date;
  v_f record;
  v_person_changed boolean;
  v_changed integer := 0;
  v_unchanged integer := 0;
  v_rows integer := 0;
  v_kept jsonb := '[]'::jsonb;
  v_main_changed integer := 0;
  v_cnt integer;
  v_area uuid;
  v_pnote_new text;
  v_pnote_cur public.weekly_shift_person_notes%rowtype;
  v_found boolean;
begin
  if not public.can_manage_admin_tab('shift_patterns') then
    raise exception 'シフトを保存する権限がありません' using errcode = '42501';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception '保存する内容がありません' using errcode = '22023';
  end if;

  v_from := nullif(p_payload->>'apply_from', '')::date;
  if v_from is null then
    raise exception '適用開始日を入れてください' using errcode = '22023';
  end if;
  if v_from < v_today and coalesce((p_payload->>'confirm_past')::boolean, false) is not true then
    return jsonb_build_object('ok', false, 'reason', 'past_confirm');
  end if;

  v_people := p_payload->'people';
  if v_people is null or jsonb_typeof(v_people) <> 'array' or jsonb_array_length(v_people) = 0 then
    raise exception '保存する人がいません' using errcode = '22023';
  end if;

  select array_agg((p->>'user_id')::uuid) into v_ids from jsonb_array_elements(v_people) p;
  if (select count(distinct x) from unnest(v_ids) x) <> cardinality(v_ids) then
    raise exception '同じ人が2回入っています' using errcode = '22023';
  end if;

  -- 🚨 2人が同時に保存しても、順番に1人ずつ処理する
  perform pg_advisory_xact_lock(hashtext('shift_patterns_save'));

  -- 🚨 開いたあとに別の人が保存していたら、上書きせずに断る
  if coalesce(p_payload->>'base_token', '') <> public.shift_patterns_token(v_ids) then
    return jsonb_build_object('ok', false, 'reason', 'stale');
  end if;

  for v_person in select value from jsonb_array_elements(v_people) loop
    v_user := (v_person->>'user_id')::uuid;
    select p.name into v_name from public.profiles p where p.id = v_user;
    if not found then
      raise exception 'スタッフが見つかりません' using errcode = 'P0002';
    end if;
    v_person_changed := false;

    -- メインの部門
    if nullif(v_person->>'main_area_id', '') is not null then
      v_area := (v_person->>'main_area_id')::uuid;
      if not exists (select 1 from public.shift_work_areas a where a.id = v_area) then
        raise exception '%さんのメインの部門が見つかりません', v_name using errcode = '22023';
      end if;
      insert into public.staff_main_work_areas (user_id, area_id, updated_at, updated_by)
      values (v_user, v_area, now(), auth.uid())
      on conflict (user_id) do update
        set area_id = excluded.area_id, updated_at = now(), updated_by = auth.uid()
        where public.staff_main_work_areas.area_id is distinct from excluded.area_id;
      get diagnostics v_cnt = row_count;
      if v_cnt > 0 then v_main_changed := v_main_changed + 1; end if;
    end if;

    -- 人ごとの書き添え（キーがあるときだけ）
    if v_person ? 'person_note' then
      v_pnote_new := nullif(btrim(coalesce(v_person->>'person_note', '')), '');
      if v_pnote_new is not null and length(v_pnote_new) > 200 then
        raise exception '%さんの書き添えは200文字までです', v_name using errcode = '22023';
      end if;
      select * into v_pnote_cur from public.weekly_shift_person_notes n
       where n.user_id = v_user and n.valid_from <= v_from and (n.valid_to is null or n.valid_to >= v_from);
      v_found := found;
      if (case when v_found then v_pnote_cur.note else null end) is distinct from v_pnote_new then
        select min(n.valid_from) into v_next from public.weekly_shift_person_notes n
         where n.user_id = v_user and n.valid_from > v_from;
        v_to := v_next - 1;
        if v_found and v_pnote_cur.valid_from = v_from then
          if v_pnote_new is null then
            delete from public.weekly_shift_person_notes where id = v_pnote_cur.id;
          else
            update public.weekly_shift_person_notes set note = v_pnote_new, saved_by = auth.uid() where id = v_pnote_cur.id;
          end if;
        else
          if v_found then
            update public.weekly_shift_person_notes set valid_to = v_from - 1 where id = v_pnote_cur.id;
          end if;
          if v_pnote_new is not null then
            insert into public.weekly_shift_person_notes (user_id, note, valid_from, valid_to, saved_by)
            values (v_user, v_pnote_new, v_from, v_to, auth.uid());
          end if;
        end if;
        v_person_changed := true;
      end if;
    end if;

    -- 曜日ごと
    if jsonb_typeof(v_person->'days') = 'object' then
      for v_day, v_day_val in select key, value from jsonb_each(v_person->'days') loop
        if v_day not in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun', 'holiday', 'work_on_closed') then
          raise exception '曜日の指定が正しくありません（%）', v_day using errcode = '22023';
        end if;
        v_new_segs := coalesce(v_day_val->'segments', '[]'::jsonb);
        v_new_note := nullif(btrim(coalesce(v_day_val->>'note', '')), '');
        if v_new_note is not null and length(v_new_note) > 100 then
          raise exception '%さんの%の書き添えは100文字までです', v_name, v_day using errcode = '22023';
        end if;

        -- 形を確かめて、今までの列を作る（おかしければここで断る。名前と曜日を添える）
        begin
          select * into v_f from public.shift_pattern_fields(v_new_segs);
        exception when sqlstate '22023' then
          raise exception '%さん（%）：%', v_name, v_day, sqlerrm using errcode = '22023';
        end;

        -- 比べる形をそろえる（時刻順・area_id の空は null）
        select coalesce(jsonb_agg(jsonb_build_object(
                 'start', lpad(split_part(x.value->>'start', ':', 1), 2, '0') || ':' || split_part(x.value->>'start', ':', 2),
                 'end', lpad(split_part(x.value->>'end', ':', 1), 2, '0') || ':' || split_part(x.value->>'end', ':', 2),
                 'location', btrim(x.value->>'location'),
                 'area_id', nullif(x.value->>'area_id', ''))
               order by (split_part(x.value->>'start', ':', 1))::int * 60 + (split_part(x.value->>'start', ':', 2))::int), '[]'::jsonb)
          into v_new_segs
          from jsonb_array_elements(v_new_segs) x;

        select * into v_cur from public.weekly_shift_patterns w
         where w.user_id = v_user and w.day_kind = v_day
           and w.valid_from <= v_from and (w.valid_to is null or w.valid_to >= v_from);
        v_found := found;

        if v_found then
          v_cur_segs := coalesce(v_cur.segments,
            public.shift_legacy_segments(v_cur.start_time, v_cur.end_time, v_cur.start_time2, v_cur.end_time2, v_cur.location));
          if v_cur_segs = v_new_segs and v_cur.note is not distinct from v_new_note then
            continue;
          end if;
        elsif jsonb_array_length(v_new_segs) = 0 and v_new_note is null then
          -- 🚨 行が無い人に「休み」の行を作らない（未登録が「全曜日休み」に変わってしまう）
          continue;
        end if;

        -- 🚨 先に登録してある版は残し、新しい版はその前日までにする
        select min(w.valid_from) into v_next from public.weekly_shift_patterns w
         where w.user_id = v_user and w.day_kind = v_day and w.valid_from > v_from;
        v_to := v_next - 1;

        if v_found and v_cur.valid_from = v_from then
          update public.weekly_shift_patterns
             set segments = v_new_segs, note = v_new_note, saved_by = auth.uid(),
                 start_time = v_f.start_time, end_time = v_f.end_time,
                 start_time2 = v_f.start_time2, end_time2 = v_f.end_time2,
                 location = v_f.location, break_minutes = v_f.break_minutes, labor_minutes = v_f.labor_minutes
           where id = v_cur.id;
        else
          if v_found then
            update public.weekly_shift_patterns set valid_to = v_from - 1 where id = v_cur.id;
          end if;
          insert into public.weekly_shift_patterns
            (user_id, day_kind, start_time, end_time, start_time2, end_time2, location,
             break_minutes, labor_minutes, valid_from, valid_to, segments, note, saved_by)
          values
            (v_user, v_day, v_f.start_time, v_f.end_time, v_f.start_time2, v_f.end_time2, v_f.location,
             v_f.break_minutes, v_f.labor_minutes, v_from, v_to, v_new_segs, v_new_note, auth.uid());
        end if;
        v_rows := v_rows + 1;
        if v_next is not null then
          v_kept := v_kept || jsonb_build_object('user_id', v_user, 'name', v_name, 'day_kind', v_day, 'until', v_to);
        end if;
        v_person_changed := true;
      end loop;
    end if;

    if v_person_changed then v_changed := v_changed + 1; else v_unchanged := v_unchanged + 1; end if;
  end loop;

  return jsonb_build_object(
    'ok', true, 'reason', null,
    'changed_people', v_changed, 'unchanged_people', v_unchanged,
    'rows_written', v_rows, 'kept_future', v_kept, 'main_area_changed', v_main_changed
  );
end;
$$;

comment on function public.shift_patterns_save(jsonb) is
  'シフト管理の一括保存（2026-09-15）。変えた人・曜日だけ新しい版／先の版は残す／今日より前は confirm_past／開いた時点の目印が違えば stale／途中で失敗したら何も残さない';

revoke execute on function public.shift_patterns_save(jsonb) from public;
revoke execute on function public.shift_patterns_save(jsonb) from anon;
grant execute on function public.shift_patterns_save(jsonb) to authenticated;
