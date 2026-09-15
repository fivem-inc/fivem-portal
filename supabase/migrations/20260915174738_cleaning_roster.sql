-- ④ 掃除担当表（2026-09-15）
-- 設計・決めたこと・レビューは docs/計画-管理画面の開放.md の 5-8〜5-8-2。
--
-- ・行（cleaning_rows：校・階・仕事）×曜日のマス（cleaning_cells）を「いつから」で版にする（変えたマスだけ・先の版は残す＝勤務表と同じ）
-- ・マスの人は別表（cleaning_cell_entries・profiles に CASCADE）。時刻の無い人（「授業前」など）は start_time が null
-- ・「この日は無し」（斜線）は is_none。空のマス（未入力）とは別。空に戻すときも版を作る
-- ・⚠️ 印は保存しない（画面が週のシフトから計算する）。「確認した」だけ cleaning_acks に残す
-- ・表に書く呼び名（staff_display_names）は掃除担当表と勉強会の欄が使う。書くのは staff_display_name_save だけ
-- ・掃除の対象外（cleaning_excluded_staff）：表の下の「休み」「担当なし」に出さない人。いつからは持たない
-- ・表の上の見出しと注意書き（cleaning_notes）。app_settings は管理者しか書けないので専用の表にする
-- ・行・注意書き・対象外は画面から直接書く（can_manage_admin_tab('shift_patterns')）。マスは cleaning_save だけ
-- 🚨 名前入りの中身（マス・呼び名）はこのファイルに入れない（リポジトリが Public のため・2026-09-15 ユーザー確定）
-- ・掃除の cron は作らない：版と確認は人が保存したときにしか増えない

-- ───────────────────────────────────────────
-- 1. 表
-- ───────────────────────────────────────────
create table if not exists public.cleaning_rows (
  id uuid primary key default gen_random_uuid(),
  school text not null,
  floor text check (floor is null or length(btrim(floor)) between 1 and 10),
  task text not null check (length(btrim(task)) between 1 and 100),
  short_name text not null check (length(btrim(short_name)) between 1 and 12),
  vacuum_mark boolean not null default false,
  note_below text check (note_below is null or length(note_below) <= 200),
  minutes integer not null default 15 check (minutes between 5 and 120),
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cleaning_cells (
  id uuid primary key default gen_random_uuid(),
  row_id uuid not null references public.cleaning_rows(id) on delete cascade,
  day_kind text not null check (day_kind in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')),
  is_none boolean not null default false,
  note text check (note is null or length(note) <= 100),
  valid_from date not null,
  valid_to date,
  saved_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint cleaning_cells_range check (valid_to is null or valid_to >= valid_from),
  constraint cleaning_cells_no_overlap
    exclude using gist (row_id with =, day_kind with =, daterange(valid_from, valid_to, '[]') with &&)
);

create index if not exists cleaning_cells_row_idx on public.cleaning_cells (row_id, day_kind, valid_from);

-- 🚨 人は profiles に CASCADE（2人共通の delete-user を止めないため）。消えた人のぶんはマスから消える
create table if not exists public.cleaning_cell_entries (
  cell_id uuid not null references public.cleaning_cells(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  start_time time,
  sort_order integer not null,
  primary key (cell_id, sort_order)
);

create index if not exists cleaning_cell_entries_user_idx on public.cleaning_cell_entries (user_id);

create table if not exists public.cleaning_acks (
  id uuid primary key default gen_random_uuid(),
  cell_id uuid not null references public.cleaning_cells(id) on delete cascade,
  issue_key text not null check (length(issue_key) between 1 and 300),
  acked_by uuid not null,
  acked_at timestamptz not null default now(),
  unique (cell_id, issue_key)
);

create table if not exists public.cleaning_excluded_staff (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  created_by uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.cleaning_notes (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('title', 'note')),
  body text not null check (length(btrim(body)) between 1 and 300),
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.staff_display_names (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  label text not null check (length(btrim(label)) between 1 and 10),
  updated_by uuid,
  updated_at timestamptz not null default now()
);

drop trigger if exists cleaning_rows_updated_at on public.cleaning_rows;
create trigger cleaning_rows_updated_at before update on public.cleaning_rows
  for each row execute function public.set_updated_at();
drop trigger if exists cleaning_cells_updated_at on public.cleaning_cells;
create trigger cleaning_cells_updated_at before update on public.cleaning_cells
  for each row execute function public.set_updated_at();
drop trigger if exists cleaning_notes_updated_at on public.cleaning_notes;
create trigger cleaning_notes_updated_at before update on public.cleaning_notes
  for each row execute function public.set_updated_at();

-- 行の校は校の一覧の値だけ。🚨 マスがある行の校・階は変えられない（過去の表まで移ってしまうため）
create or replace function public.cleaning_rows_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not exists (select 1 from public.master_options mo where mo.category = 'workplace' and mo.value = new.school) then
    raise exception '「%」という校はありません', new.school using errcode = '22023';
  end if;
  if tg_op = 'UPDATE' and (new.school is distinct from old.school or new.floor is distinct from old.floor)
     and exists (select 1 from public.cleaning_cells c where c.row_id = old.id) then
    raise exception 'マスが入っている行の校・階は変えられません。新しい行を足して、この行を隠してください' using errcode = '22023';
  end if;
  return new;
end;
$$;

drop trigger if exists cleaning_rows_guard on public.cleaning_rows;
create trigger cleaning_rows_guard before insert or update on public.cleaning_rows
  for each row execute function public.cleaning_rows_guard();

comment on table public.cleaning_rows is '掃除担当表の行（校・階・仕事・勤務表に出す短い名前・＊印・行の下の注意書き・掃除の長さ）。消さずに隠す（2026-09-15）';
comment on table public.cleaning_cells is '掃除担当表のマスの版（行×曜日×valid_from/valid_to・この日は無し・書き添え）。書くのは cleaning_save だけ';
comment on table public.cleaning_cell_entries is '掃除担当表のマスに入る人と開始時刻（時刻なしは null）。書くのは cleaning_save だけ';
comment on table public.cleaning_acks is '掃除担当表の ⚠️ 印を「確認した」記録（マスの版×ずれの中身）';
comment on table public.cleaning_excluded_staff is '掃除の対象外（表の下の「休み」「担当なし」に出さない人）';
comment on table public.cleaning_notes is '掃除担当表の見出し（title）と表の上の注意書き（note）';
comment on table public.staff_display_names is '表に書く呼び名（掃除担当表・勉強会の欄）。在籍者の中でかぶらない。書くのは staff_display_name_save だけ';

-- ───────────────────────────────────────────
-- 2. 読み書きの決まり
-- ───────────────────────────────────────────
alter table public.cleaning_rows enable row level security;
alter table public.cleaning_cells enable row level security;
alter table public.cleaning_cell_entries enable row level security;
alter table public.cleaning_acks enable row level security;
alter table public.cleaning_excluded_staff enable row level security;
alter table public.cleaning_notes enable row level security;
alter table public.staff_display_names enable row level security;

drop policy if exists cleaning_rows_select on public.cleaning_rows;
create policy cleaning_rows_select on public.cleaning_rows
  for select to authenticated using ((select public.can_manage_admin_tab('shift_patterns')));
drop policy if exists cleaning_rows_insert on public.cleaning_rows;
create policy cleaning_rows_insert on public.cleaning_rows
  for insert to authenticated with check ((select public.can_manage_admin_tab('shift_patterns')));
drop policy if exists cleaning_rows_update on public.cleaning_rows;
create policy cleaning_rows_update on public.cleaning_rows
  for update to authenticated
  using ((select public.can_manage_admin_tab('shift_patterns')))
  with check ((select public.can_manage_admin_tab('shift_patterns')));

drop policy if exists cleaning_cells_select on public.cleaning_cells;
create policy cleaning_cells_select on public.cleaning_cells
  for select to authenticated using ((select public.can_manage_admin_tab('shift_patterns')));

drop policy if exists cleaning_cell_entries_select on public.cleaning_cell_entries;
create policy cleaning_cell_entries_select on public.cleaning_cell_entries
  for select to authenticated using ((select public.can_manage_admin_tab('shift_patterns')));

drop policy if exists cleaning_acks_select on public.cleaning_acks;
create policy cleaning_acks_select on public.cleaning_acks
  for select to authenticated using ((select public.can_manage_admin_tab('shift_patterns')));
drop policy if exists cleaning_acks_insert on public.cleaning_acks;
create policy cleaning_acks_insert on public.cleaning_acks
  for insert to authenticated
  with check ((select public.can_manage_admin_tab('shift_patterns')) and acked_by = (select auth.uid()));

drop policy if exists cleaning_excluded_staff_select on public.cleaning_excluded_staff;
create policy cleaning_excluded_staff_select on public.cleaning_excluded_staff
  for select to authenticated using ((select public.can_manage_admin_tab('shift_patterns')));
drop policy if exists cleaning_excluded_staff_insert on public.cleaning_excluded_staff;
create policy cleaning_excluded_staff_insert on public.cleaning_excluded_staff
  for insert to authenticated with check ((select public.can_manage_admin_tab('shift_patterns')));
drop policy if exists cleaning_excluded_staff_delete on public.cleaning_excluded_staff;
create policy cleaning_excluded_staff_delete on public.cleaning_excluded_staff
  for delete to authenticated using ((select public.can_manage_admin_tab('shift_patterns')));

drop policy if exists cleaning_notes_select on public.cleaning_notes;
create policy cleaning_notes_select on public.cleaning_notes
  for select to authenticated using ((select public.can_manage_admin_tab('shift_patterns')));
drop policy if exists cleaning_notes_insert on public.cleaning_notes;
create policy cleaning_notes_insert on public.cleaning_notes
  for insert to authenticated with check ((select public.can_manage_admin_tab('shift_patterns')));
drop policy if exists cleaning_notes_update on public.cleaning_notes;
create policy cleaning_notes_update on public.cleaning_notes
  for update to authenticated
  using ((select public.can_manage_admin_tab('shift_patterns')))
  with check ((select public.can_manage_admin_tab('shift_patterns')));

drop policy if exists staff_display_names_select on public.staff_display_names;
create policy staff_display_names_select on public.staff_display_names
  for select to authenticated using ((select public.can_manage_admin_tab('shift_patterns')));

-- ───────────────────────────────────────────
-- 3. 行の一覧と注意書き（紙の 2026/9/16～ の表から・名前は入れない）
-- ───────────────────────────────────────────
insert into public.cleaning_rows (school, floor, task, short_name, vacuum_mark, note_below, minutes, sort_order)
select r.school, r.floor, r.task, r.short_name, r.vacuum_mark, r.note_below, r.minutes, r.sort_order
from (values
  ('四条本校', '4F', '朝の受付・電話', '受付', false, null::text, 15, 10),
  ('四条本校', '4F', 'フロア掃除機(女更衣室･廊下･ロビー･カフェ)', '掃除機', true, null, 15, 20),
  ('四条本校', '4F', '拭き掃除(棚･イス・鏡･サン等･カフェ）･女子シャワー', '拭き掃除', false, null, 15, 30),
  ('四条本校', '4F', 'トイレ', 'トイレ', false, null, 15, 40),
  ('四条本校', '4F', '男子シャワー･掃除機(休憩室･受付・男更衣室)', '男子シャワー', false,
     '（受付内掃除機のみ、電話の妨げにならないように12:15～13:15の間でお願い致します。）', 15, 50),
  ('四条本校', '4F', 'エアコン', 'エアコン', false, null, 15, 60),
  ('四条本校', '3F', 'フロア・会議室　掃除機・コロコロ', '掃除機', true, null, 15, 70),
  ('四条本校', '3F', '拭き掃除(サン･バー･棚･ジョイントマット･会議室)', '拭き掃除', false, null, 15, 80),
  ('四条本校', '3F', 'トイレ', 'トイレ', false, null, 15, 90),
  ('四条本校', '5F', 'フロア掃除機・コロコロ', '掃除機', true, null, 15, 100),
  ('四条本校', '5F', '拭き掃除（サン・バー・鏡・器具など）', '拭き掃除', false, null, 15, 110),
  ('四条本校', '5F', 'トイレ', 'トイレ', false, null, 15, 120),
  ('四条本校', '6F', 'フロア掃除機･プライベートルーム', '掃除機', true, null, 15, 130),
  ('四条本校', '6F', '第2スタジオ･拭き掃除', '第2スタジオ', false, null, 15, 140),
  ('四条本校', '6F', 'トイレ', 'トイレ', false, null, 15, 150),
  ('四条本校', null, '看板･外回り(月･木)･階段手すり(1～3階)･傘立て他', '看板・外回り', false, null, 15, 160),
  ('西陣校', null, '掃除機（ゆか・助走路）', '掃除機', true, null, 15, 170),
  ('西陣校', null, '拭き掃除(窓･鏡）・靴箱・入口掃除', '拭き掃除', false, null, 15, 180),
  ('西陣校', null, 'トイレ・洗面台', 'トイレ', false, null, 15, 190),
  ('西陣校', null, '更衣室・外回り掃除（西陣前～南北50ｍ）', '更衣室・外回り', false, null, 15, 200),
  ('西陣校', null, 'ゴミ出し', 'ゴミ出し', false, null, 15, 210),
  ('上桂校', null, '窓・受付・入口掃除', '窓・受付', false, null, 30, 220),
  ('上桂校', null, '館内履き掃除・コロコロ', '館内履き', false, null, 30, 230),
  ('上桂校', null, '外回り掃除（駐車場、歩道のバス停～体育館裏まで）', '外回り', false, null, 30, 240),
  ('上桂校', null, 'トイレ・洗面台', 'トイレ', false, null, 30, 250),
  ('上桂校', null, 'スタッフルーム・男女更衣室・鏡', 'スタッフルーム', false, null, 30, 260),
  ('洛西口校', null, '外回り・窓拭き', '外回り・窓拭き', false, null, 15, 270),
  ('洛西口校', null, 'フロア掃除機', '掃除機', true, null, 15, 280),
  ('洛西口校', null, 'トイレ', 'トイレ', false, null, 15, 290),
  ('南草津校', null, '掃除機・入口掃除', '掃除機', false, null, 15, 300),
  ('南草津校', null, '拭き掃除（棚・窓内外など）', '拭き掃除', false, null, 15, 310)
) as r(school, floor, task, short_name, vacuum_mark, note_below, minutes, sort_order)
where not exists (select 1 from public.cleaning_rows);

insert into public.cleaning_notes (kind, body, sort_order)
select n.kind, n.body, n.sort_order
from (values
  ('title', '毎日の掃除担当表（本校・西陣・洛西口・南草津校10分～15分間　上桂20分～30分）', 10),
  ('note', '＊出勤後すぐの掃除は、着替えを終えてから始めていただいてますが、担当表の掃除開始時間は出勤時間で表記しております。', 20),
  ('note', '＊調整があった場合は、各校で変更をお願いします。', 30),
  ('note', '＊本校こどもスタッフ　3，5階で朝授業がない日は午後授業前でも可。', 40)
) as n(kind, body, sort_order)
where not exists (select 1 from public.cleaning_notes);

-- ───────────────────────────────────────────
-- 4. 開いた時点の目印
-- ───────────────────────────────────────────
create or replace function public.cleaning_token()
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
                from public.cleaning_cells c), '')
    || '|' ||
    coalesce((select string_agg(e.cell_id::text || e.sort_order::text || e.user_id::text || coalesce(e.start_time::text, '-'), ',' order by e.cell_id, e.sort_order)
                from public.cleaning_cell_entries e), '')
  );
end;
$$;

revoke execute on function public.cleaning_token() from public;
revoke execute on function public.cleaning_token() from anon;
grant execute on function public.cleaning_token() to authenticated;

-- ───────────────────────────────────────────
-- 5. 保存（変えたマスだけ）
-- ───────────────────────────────────────────
-- p_payload：{ "apply_from":"2026-10-01", "confirm_past":false, "base_token":"…",
--              "cells":[ { "row_id":uuid, "day_kind":"mon", "is_none":false, "note":"(会)"|null,
--                          "entries":[ { "user_id":uuid, "start":"9:30"|null }, … ] }, … ] }
-- 画面は「適用開始日に効いている中身と違うマス」だけを送る。関数でも同じなら何もしない
-- 戻り値：{ ok, reason('past_confirm'|'stale'|null), changed, unchanged, kept_future:[{row_id, day_kind, next_from}] }
create or replace function public.cleaning_save(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_from date;
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_cell jsonb;
  v_entry jsonb;
  v_row uuid;
  v_day text;
  v_none boolean;
  v_note text;
  v_new_sig text;
  v_cur_sig text;
  v_cur public.cleaning_cells%rowtype;
  v_found boolean;
  v_to date;
  v_next date;
  v_id uuid;
  v_changed integer := 0;
  v_unchanged integer := 0;
  v_kept jsonb := '[]'::jsonb;
begin
  if not public.can_manage_admin_tab('shift_patterns') then
    raise exception '掃除担当表を保存する権限がありません' using errcode = '42501';
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
  if jsonb_array_length(p_payload->'cells') > 500 then
    raise exception '一度に保存できるのは500マスまでです' using errcode = '22023';
  end if;

  for v_cell in select x.value from jsonb_array_elements(p_payload->'cells') x loop
    if jsonb_typeof(v_cell) <> 'object' or coalesce(v_cell->>'row_id', '') !~ '^[0-9a-fA-F-]{36}$' then
      raise exception 'マスの指定が正しくありません' using errcode = '22023';
    end if;
    if not exists (select 1 from public.cleaning_rows r where r.id = (v_cell->>'row_id')::uuid) then
      raise exception '行が見つかりません（ほかの人が直した可能性があります）' using errcode = 'P0002';
    end if;
    if coalesce(v_cell->>'day_kind', '') not in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun') then
      raise exception '曜日の指定が正しくありません' using errcode = '22023';
    end if;
    if jsonb_typeof(v_cell->'is_none') is distinct from 'boolean' then
      raise exception '「この日は無し」の指定が正しくありません' using errcode = '22023';
    end if;
    if v_cell ? 'note' and jsonb_typeof(v_cell->'note') not in ('string', 'null') then
      raise exception '書き添えの指定が正しくありません' using errcode = '22023';
    end if;
    if length(coalesce(v_cell->>'note', '')) > 100 then
      raise exception '書き添えは100文字までです' using errcode = '22023';
    end if;
    if jsonb_typeof(v_cell->'entries') is distinct from 'array' then
      raise exception '人の指定が正しくありません' using errcode = '22023';
    end if;
    if jsonb_array_length(v_cell->'entries') > 6 then
      raise exception '1つのマスに入れられるのは6人までです' using errcode = '22023';
    end if;
    if (v_cell->>'is_none')::boolean and jsonb_array_length(v_cell->'entries') > 0 then
      raise exception '「この日は無し」のマスに人は入れられません' using errcode = '22023';
    end if;
    for v_entry in select y.value from jsonb_array_elements(v_cell->'entries') y loop
      if jsonb_typeof(v_entry) <> 'object' or coalesce(v_entry->>'user_id', '') !~ '^[0-9a-fA-F-]{36}$' then
        raise exception '人の指定が正しくありません' using errcode = '22023';
      end if;
      if not exists (select 1 from public.profiles p where p.id = (v_entry->>'user_id')::uuid) then
        raise exception 'スタッフが見つかりません（削除された可能性があります）' using errcode = 'P0002';
      end if;
      if v_entry ? 'start' and jsonb_typeof(v_entry->'start') not in ('string', 'null') then
        raise exception '時刻の指定が正しくありません' using errcode = '22023';
      end if;
      if coalesce(v_entry->>'start', '') <> '' and (v_entry->>'start') !~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' then
        raise exception '時刻は「9:30」の形で入れてください' using errcode = '22023';
      end if;
    end loop;
    if (select count(*) from jsonb_array_elements(v_cell->'entries') y)
       <> (select count(distinct (y.value->>'user_id') || '@' || coalesce(to_char(nullif(y.value->>'start', '')::time, 'HH24:MI'), ''))
             from jsonb_array_elements(v_cell->'entries') y) then
      -- 🚨 「9:30」と「09:30」は同じ時刻として数える（形は上で確かめ済み）
      raise exception '同じマスに同じ人・同じ時刻が2回入っています' using errcode = '22023';
    end if;
  end loop;

  if (select count(*) from jsonb_array_elements(p_payload->'cells') x)
     <> (select count(distinct (x.value->>'row_id') || (x.value->>'day_kind')) from jsonb_array_elements(p_payload->'cells') x) then
    raise exception '同じマスが2回入っています' using errcode = '22023';
  end if;

  if v_from < v_today and coalesce((p_payload->>'confirm_past')::boolean, false) is not true then
    return jsonb_build_object('ok', false, 'reason', 'past_confirm');
  end if;

  perform pg_advisory_xact_lock(hashtext('cleaning_save'));
  if coalesce(p_payload->>'base_token', '') <> public.cleaning_token() then
    return jsonb_build_object('ok', false, 'reason', 'stale');
  end if;

  -- ── ここから書き込み（🚨 以降は ok:false を返さない。失敗は raise で全部取り消す） ──
  for v_cell in select x.value from jsonb_array_elements(p_payload->'cells') x loop
    v_row := (v_cell->>'row_id')::uuid;
    v_day := v_cell->>'day_kind';
    v_none := (v_cell->>'is_none')::boolean;
    v_note := nullif(btrim(coalesce(v_cell->>'note', '')), '');
    select coalesce(string_agg((y.value->>'user_id') || '@' || coalesce(to_char(nullif(y.value->>'start', '')::time, 'HH24:MI'), ''), ',' order by y.ord), '')
      into v_new_sig
      from jsonb_array_elements(v_cell->'entries') with ordinality as y(value, ord);

    select * into v_cur from public.cleaning_cells c
     where c.row_id = v_row and c.day_kind = v_day and c.valid_from <= v_from and (c.valid_to is null or c.valid_to >= v_from);
    v_found := found;

    if v_found then
      select coalesce(string_agg(e.user_id::text || '@' || coalesce(to_char(e.start_time, 'HH24:MI'), ''), ',' order by e.sort_order), '')
        into v_cur_sig
        from public.cleaning_cell_entries e where e.cell_id = v_cur.id;
      if v_cur.is_none = v_none and v_cur.note is not distinct from v_note and v_cur_sig = v_new_sig then
        v_unchanged := v_unchanged + 1;
        continue;
      end if;
      if v_cur.valid_from = v_from then
        update public.cleaning_cells set is_none = v_none, note = v_note, saved_by = auth.uid() where id = v_cur.id;
        delete from public.cleaning_cell_entries e where e.cell_id = v_cur.id;
        delete from public.cleaning_acks a where a.cell_id = v_cur.id;
        v_id := v_cur.id;
      else
        v_to := v_cur.valid_to;
        update public.cleaning_cells set valid_to = v_from - 1 where id = v_cur.id;
        insert into public.cleaning_cells (row_id, day_kind, is_none, note, valid_from, valid_to, saved_by)
        values (v_row, v_day, v_none, v_note, v_from, v_to, auth.uid())
        returning id into v_id;
        if v_to is not null then
          v_kept := v_kept || jsonb_build_object('row_id', v_row, 'day_kind', v_day, 'next_from', v_to + 1);
        end if;
      end if;
    else
      -- この日に効いている版が無い。空のままなら作らない。先の版があればその前日まで
      if not v_none and v_note is null and v_new_sig = '' then
        v_unchanged := v_unchanged + 1;
        continue;
      end if;
      select min(c.valid_from) into v_next from public.cleaning_cells c
       where c.row_id = v_row and c.day_kind = v_day and c.valid_from > v_from;
      insert into public.cleaning_cells (row_id, day_kind, is_none, note, valid_from, valid_to, saved_by)
      values (v_row, v_day, v_none, v_note, v_from, v_next - 1, auth.uid())
      returning id into v_id;
      if v_next is not null then
        v_kept := v_kept || jsonb_build_object('row_id', v_row, 'day_kind', v_day, 'next_from', v_next);
      end if;
    end if;

    insert into public.cleaning_cell_entries (cell_id, user_id, start_time, sort_order)
    select v_id, (y.value->>'user_id')::uuid, nullif(y.value->>'start', '')::time, y.ord
      from jsonb_array_elements(v_cell->'entries') with ordinality as y(value, ord);
    v_changed := v_changed + 1;
  end loop;

  return jsonb_build_object('ok', true, 'reason', null, 'changed', v_changed, 'unchanged', v_unchanged, 'kept_future', v_kept);
end;
$$;

comment on function public.cleaning_save(jsonb) is
  '掃除担当表のマスを保存（変えたマスだけ版・先の版は残す・今日より前は確認・stale で断る・確かめは書き込み前に全部）（2026-09-15）';

revoke execute on function public.cleaning_save(jsonb) from public;
revoke execute on function public.cleaning_save(jsonb) from anon;
grant execute on function public.cleaning_save(jsonb) to authenticated;

-- ───────────────────────────────────────────
-- 6. 呼び名の保存（空なら消す）
-- ───────────────────────────────────────────
create or replace function public.staff_display_name_save(p_user_id uuid, p_label text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_label text := nullif(btrim(coalesce(p_label, '')), '');
  v_other text;
begin
  if not public.can_manage_admin_tab('shift_patterns') then
    raise exception '呼び名を保存する権限がありません' using errcode = '42501';
  end if;
  if p_user_id is null or not exists (select 1 from public.profiles p where p.id = p_user_id) then
    raise exception 'スタッフが見つかりません' using errcode = 'P0002';
  end if;
  if v_label is not null and length(v_label) > 10 then
    raise exception '呼び名は10文字までです' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('staff_display_name_save'));
  if v_label is null then
    delete from public.staff_display_names d where d.user_id = p_user_id;
    return jsonb_build_object('ok', true);
  end if;
  -- 🚨 在籍者の呼び名とかぶらない（退職した人の呼び名は数えない）
  select p.name into v_other
    from public.staff_display_names d join public.profiles p on p.id = d.user_id
   where d.label = v_label and d.user_id <> p_user_id and p.is_active
   limit 1;
  if v_other is not null then
    raise exception '「%」は%さんの呼び名です', v_label, v_other using errcode = '23505';
  end if;
  insert into public.staff_display_names (user_id, label, updated_by, updated_at)
  values (p_user_id, v_label, auth.uid(), now())
  on conflict (user_id) do update set label = excluded.label, updated_by = excluded.updated_by, updated_at = now();
  return jsonb_build_object('ok', true);
end;
$$;

comment on function public.staff_display_name_save(uuid, text) is '表に書く呼び名の保存（空なら消す・在籍者でかぶり禁止）（2026-09-15）';

revoke execute on function public.staff_display_name_save(uuid, text) from public;
revoke execute on function public.staff_display_name_save(uuid, text) from anon;
grant execute on function public.staff_display_name_save(uuid, text) to authenticated;

revoke execute on function public.cleaning_rows_guard() from public;
revoke execute on function public.cleaning_rows_guard() from anon;
