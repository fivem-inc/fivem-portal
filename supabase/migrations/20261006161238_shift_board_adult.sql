-- 大人シフト表の準備 ①（2026-10-06）：こどもシフト表の表に「どの表か（board）」を足し、同じ仕組みで大人シフト表も持てるようにする。
-- 設計は docs/計画-大人シフト表.md。
--
-- 🚨 関数はすべて本番の pg_get_functiondef（2026-10-06 取得）から起こした。repo の 20260916092222 は使っていない。
-- 🚨 この migration は「入れ物」だけ。大人の置き場所・大人用の行の種類・本校の「3F・5F 共通」の置き場所は入れない。
--    今のこどもの画面は board で絞らずに全部読むので、先に入れると今の画面に出てしまう。
--    それぞれ、その行を読む画面（② こども・④ 大人）と同じ回に入れる。
-- 🚨 今あるこどもの値は変えない：
--    ・board は既定 'kids'。今の行はすべて 'kids' になる
--    ・マスの署名（cell_sig / payload_sig）は、新しい欄に値があるときだけ末尾に足す＝今の署名は1文字も変わらない
--    ・kids_shift_token() を引数なしで呼ぶと、今までと同じ値が返る（こどもの行しか無いため）
--
-- あわせて直すもの（2026-10-06 に見つけた）：
--    中で使うだけの関数（put_items・open_version・check_items・cell_sig・payload_sig）に、
--    ログインした人なら誰でも直接呼べる権限が付いていた（authenticated）。put_items と open_version は
--    権限を確かめずに書き込む作りなので、画面を通さずに呼べばパートでもマスを書き換えられた。
--    → authenticated から外す（保存・案・決定の関数の中から呼ぶのは、関数の持ち主の権限なので影響しない）

-- ════════════════════════════════════════════════════════════
-- 1. 表
-- ════════════════════════════════════════════════════════════

-- 置き場所：どの表か／新しい種類 pool（本校の「3F・5F 共通の人」）・trip（大人の出張の細い列）
alter table public.kids_shift_places
  add column if not exists board text not null default 'kids';
alter table public.kids_shift_places drop constraint if exists kids_shift_places_board_check;
alter table public.kids_shift_places
  add constraint kids_shift_places_board_check check (board in ('kids', 'adult'));
alter table public.kids_shift_places drop constraint if exists kids_shift_places_kind_check;
alter table public.kids_shift_places
  add constraint kids_shift_places_kind_check check (kind in ('column', 'head', 'daynote', 'pool', 'trip'));
alter table public.kids_shift_places drop constraint if exists kids_shift_places_pool;
alter table public.kids_shift_places
  add constraint kids_shift_places_pool check (kind <> 'pool' or (board = 'kids' and school is not null and floor is null));
alter table public.kids_shift_places drop constraint if exists kids_shift_places_trip;
alter table public.kids_shift_places
  add constraint kids_shift_places_trip check (kind <> 'trip' or (board = 'adult' and school is null and floor is null));
-- 🚨 同じ「種類・校・階」でも、表が違えば別の置き場所（例：こどもの 本校 6F と 大人の 本校 6F）
drop index if exists public.kids_shift_places_uniq;
create unique index kids_shift_places_uniq
  on public.kids_shift_places (board, kind, coalesce(school, ''), coalesce(floor, '')) where active;
comment on column public.kids_shift_places.board is 'どの表の置き場所か（kids＝こどもシフト表／adult＝大人シフト表）。マスが入ったあとは変えられない';

-- 案：どの表の案か（案と決定はこども・大人で別々）
alter table public.kids_shift_plans
  add column if not exists board text not null default 'kids';
alter table public.kids_shift_plans drop constraint if exists kids_shift_plans_board_check;
alter table public.kids_shift_plans
  add constraint kids_shift_plans_board_check check (board in ('kids', 'adult'));
create index if not exists kids_shift_plans_board_idx on public.kids_shift_plans (board, status);
comment on column public.kids_shift_plans.board is 'どの表の案か（kids／adult）。作業中の案の上限も表ごとに数える';

-- 表全体の書き添え：どの表のものか
alter table public.kids_shift_notes
  add column if not exists board text not null default 'kids';
alter table public.kids_shift_notes drop constraint if exists kids_shift_notes_board_check;
alter table public.kids_shift_notes
  add constraint kids_shift_notes_board_check check (board in ('kids', 'adult'));

-- 行の種類：どの表で使えるか（P は両方など）／別の仕事の長さ（終わりが無いときに重なりを見る長さ）
alter table public.kids_shift_row_kinds
  add column if not exists boards text[] not null default array['kids']::text[];
alter table public.kids_shift_row_kinds drop constraint if exists kids_shift_row_kinds_boards_check;
alter table public.kids_shift_row_kinds
  add constraint kids_shift_row_kinds_boards_check
  check (cardinality(boards) >= 1 and boards <@ array['kids', 'adult']::text[]);
alter table public.kids_shift_row_kinds
  add column if not exists default_minutes integer;
alter table public.kids_shift_row_kinds drop constraint if exists kids_shift_row_kinds_default_minutes_check;
alter table public.kids_shift_row_kinds
  add constraint kids_shift_row_kinds_default_minutes_check
  check (default_minutes is null or default_minutes between 5 and 240);
comment on column public.kids_shift_row_kinds.boards is 'この種類を使える表（kids／adult）';
comment on column public.kids_shift_row_kinds.default_minutes is '終わりの時刻が無い行の長さ（分）。重なりを見るときに使う。空＝その行の時刻だけ';

-- 行：大人のクラスの前半・後半の境（空＝ちょうど半分）／映像の授業（前半・後半）／こどもの「共通の人で回す」印
alter table public.kids_shift_items add column if not exists split_time time;
alter table public.kids_shift_items add column if not exists video text;
alter table public.kids_shift_items drop constraint if exists kids_shift_items_video_check;
alter table public.kids_shift_items
  add constraint kids_shift_items_video_check check (video is null or video in ('first', 'second'));
alter table public.kids_shift_items add column if not exists use_pool boolean not null default false;
comment on column public.kids_shift_items.split_time is '大人：前半と後半の境の時刻。空＝ちょうど半分';
comment on column public.kids_shift_items.video is '大人：映像の授業（first＝前半／second＝後半）。空＝映像ではない';
comment on column public.kids_shift_items.use_pool is 'こども：本校の「3F・5F 共通の人」で回すクラス';

-- 人の役割：大人の 後半の担当（second）・後半のサポート（second_support）・補助（assist）を足す
--   こどもの lead＝担当・onduty＝（勤務中）・support＝（サポート）はそのまま。大人では lead＝前半の担当・support＝前半のサポート
alter table public.kids_shift_item_people drop constraint if exists kids_shift_item_people_role_check;
alter table public.kids_shift_item_people
  add constraint kids_shift_item_people_role_check
  check (role in ('lead', 'onduty', 'support', 'second', 'second_support', 'assist'));

-- ════════════════════════════════════════════════════════════
-- 2. 見張り（トリガー）
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.kids_shift_places_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  -- 🚨 表を変えると、決定済みの版と案のマスが別の表へ移ってしまう
  if tg_op = 'UPDATE' and new.board is distinct from old.board
     and (exists (select 1 from public.kids_shift_cells c where c.place_id = old.id)
          or exists (select 1 from public.kids_shift_plan_cells pc where pc.place_id = old.id)) then
    raise exception 'マスが入っている置き場所の表（こども・大人）は変えられません' using errcode = '22023';
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.kids_shift_row_kinds_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  -- 🚨 使っている表から外すと、その表の行が「使えない種類」になる
  if tg_op = 'UPDATE' and new.boards is distinct from old.boards
     and exists (
       select 1
         from public.kids_shift_items i
         left join public.kids_shift_cells c on c.id = i.cell_id
         left join public.kids_shift_plan_cells pc on pc.id = i.plan_cell_id
         join public.kids_shift_places pl on pl.id = coalesce(c.place_id, pc.place_id)
        where i.kind_key = old.key and not (pl.board = any (new.boards))) then
    raise exception 'この種類を使っている表から外すことはできません' using errcode = '22023';
  end if;
  return new;
end;
$function$;

-- ════════════════════════════════════════════════════════════
-- 3. 署名（新しい欄は値があるときだけ末尾に足す）
-- ════════════════════════════════════════════════════════════

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
             coalesce((select string_agg(pe.user_id::text || ':' || pe.role || ':' ||
                                         coalesce(to_char(pe.start_time, 'HH24:MI'), '') || '-' ||
                                         coalesce(to_char(pe.end_time, 'HH24:MI'), ''), ',' order by pe.sort_order)
                         from public.kids_shift_item_people pe where pe.item_id = i.id), '')
             -- 🚨 2026-10-06 追加。値が無いときは何も足さない（今の署名を変えないため）。payload_sig と同じ形にすること
             || case when i.split_time is not null or i.video is not null or i.use_pool
                     then '/+' || coalesce(to_char(i.split_time, 'HH24:MI'), '') || ':' || coalesce(i.video, '') || ':' || i.use_pool::text
                     else '' end as line
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
           coalesce((select string_agg((y.value->>'user_id') || ':' || coalesce(nullif(y.value->>'role', ''), 'lead') || ':' ||
                                       coalesce(to_char(nullif(y.value->>'start', '')::time, 'HH24:MI'), '') || '-' ||
                                       coalesce(to_char(nullif(y.value->>'end', '')::time, 'HH24:MI'), ''), ',' order by y.ord)
                      from jsonb_array_elements(coalesce(x.value->'people', '[]'::jsonb)) with ordinality as y(value, ord)), '')
           -- 🚨 2026-10-06 追加。cell_sig と同じ形（値が無いときは何も足さない）
           || case when nullif(x.value->>'split_time', '') is not null or nullif(x.value->>'video', '') is not null
                        or coalesce((x.value->>'use_pool')::boolean, false)
                   then '/+' || coalesce(to_char(nullif(x.value->>'split_time', '')::time, 'HH24:MI'), '') || ':'
                        || coalesce(nullif(x.value->>'video', ''), '') || ':'
                        || coalesce((x.value->>'use_pool')::boolean, false)::text
                   else '' end as line
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as x(value, ord)
  ) z;
$function$;

-- ════════════════════════════════════════════════════════════
-- 4. 表ごとの token（🚨 引数なしは drop して、既定値つきで作り直す。両方残すと「どちらを呼ぶか決められない」で全滅する）
-- ════════════════════════════════════════════════════════════

drop function if exists public.kids_shift_token();

CREATE OR REPLACE FUNCTION public.kids_shift_token(p_board text default 'kids')
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if not public.can_manage_admin_tab('shift_patterns') then
    raise exception '権限がありません' using errcode = '42501';
  end if;
  if p_board is null or p_board not in ('kids', 'adult') then
    raise exception '表の指定が正しくありません' using errcode = '22023';
  end if;
  -- 🚨 こどもを保存しても大人の token は変わらない（その逆も）。並べ方・つなぎ方は 2026-10-06 より前と同じ
  return md5(
    coalesce((select string_agg(c.id::text || c.updated_at::text || coalesce(c.valid_to::text, '-'), ',' order by c.id)
                from public.kids_shift_cells c
                join public.kids_shift_places pl on pl.id = c.place_id
               where pl.board = p_board), '')
    || '|' ||
    coalesce((select string_agg(p.id::text || p.revision::text || p.status || p.apply_from::text, ',' order by p.id)
                from public.kids_shift_plans p
               where p.board = p_board), '')
  );
end;
$function$;

-- ════════════════════════════════════════════════════════════
-- 5. 行の確かめ（表ごとに使える種類・役割・欄を見る）
-- ════════════════════════════════════════════════════════════

drop function if exists public.kids_shift_check_items(jsonb);

CREATE OR REPLACE FUNCTION public.kids_shift_check_items(p_items jsonb, p_board text default 'kids')
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
      v_role := coalesce(nullif(v_person->>'role', ''), 'lead');
      -- 🚨 表ごとに使える役割が違う（こども：担当・（勤務中）・サポート／大人：前半・後半の担当とサポート・補助）
      if (p_board = 'kids' and v_role not in ('lead', 'onduty', 'support'))
         or (p_board = 'adult' and v_role not in ('lead', 'support', 'second', 'second_support', 'assist')) then
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
$function$;

-- ════════════════════════════════════════════════════════════
-- 6. 行を書く・写す（🚨 新しい欄はこの2つにだけ書く。案を写す・決定するは copy_items 1つを通る）
-- ════════════════════════════════════════════════════════════

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
       role_key, is_none, note, sort_order, split_time, video, use_pool)
    values (p_cell_id, p_plan_cell_id, v_item->>'kind',
            nullif(v_item->>'start', '')::time, nullif(v_item->>'end', '')::time,
            nullif(btrim(coalesce(v_item->>'class_name', '')), ''),
            nullif(v_item->>'groups', '')::int, nullif(v_item->>'required', '')::int,
            nullif(v_item->>'min_lesson', '')::int, nullif(v_item->>'role_key', ''),
            coalesce((v_item->>'is_none')::boolean, false),
            nullif(btrim(coalesce(v_item->>'note', '')), ''), v_ord,
            nullif(v_item->>'split_time', '')::time, nullif(v_item->>'video', ''),
            coalesce((v_item->>'use_pool')::boolean, false))
    returning id into v_id;
    insert into public.kids_shift_item_people (item_id, user_id, role, start_time, end_time, sort_order)
    select v_id, (y.value->>'user_id')::uuid, coalesce(nullif(y.value->>'role', ''), 'lead'),
           nullif(y.value->>'start', '')::time, nullif(y.value->>'end', '')::time, y.ord
      from jsonb_array_elements(coalesce(v_item->'people', '[]'::jsonb)) with ordinality as y(value, ord);
  end loop;
end;
$function$;

-- 案のマスの中身を、別の案のマス（写して作る）か決定済みの版（決定）へ写す。写す先の中身は消してから写す
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
     role_key, is_none, note, sort_order, split_time, video, use_pool)
  select p_dst_cell, p_dst_plan_cell, i.kind_key, i.start_time, i.end_time, i.class_name, i.groups, i.required,
         i.min_lesson, i.role_key, i.is_none, i.note, i.sort_order, i.split_time, i.video, i.use_pool
    from public.kids_shift_items i where i.plan_cell_id = p_src_plan_cell;
  -- 🚨 人は sort_order で新しい行と結び付ける（1つのマスの中で sort_order は重ならない）
  insert into public.kids_shift_item_people (item_id, user_id, role, start_time, end_time, sort_order)
  select ni.id, pe.user_id, pe.role, pe.start_time, pe.end_time, pe.sort_order
    from public.kids_shift_items oi
    join public.kids_shift_item_people pe on pe.item_id = oi.id
    join public.kids_shift_items ni
      on ni.sort_order = oi.sort_order
     and ((p_dst_cell is not null and ni.cell_id = p_dst_cell)
          or (p_dst_plan_cell is not null and ni.plan_cell_id = p_dst_plan_cell))
   where oi.plan_cell_id = p_src_plan_cell;
end;
$function$;

-- ════════════════════════════════════════════════════════════
-- 7. 決定済みの表の保存（payload に board。既定は 'kids'＝今のこどもの画面はそのまま動く）
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.kids_shift_save(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_board text;
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
    raise exception 'シフト表を保存する権限がありません' using errcode = '42501';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception '保存する内容がありません' using errcode = '22023';
  end if;

  -- ── 確かめ（🚨 書き込みより前に全部済ませる） ──
  v_board := coalesce(nullif(p_payload->>'board', ''), 'kids');
  if v_board not in ('kids', 'adult') then
    raise exception '表の指定が正しくありません' using errcode = '22023';
  end if;
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
    -- 🚨 ほかの表の置き場所が混ざっていたら断る（こどもの保存で大人のマスを書かない）
    if not exists (select 1 from public.kids_shift_places p where p.id = (v_cell->>'place_id')::uuid and p.board = v_board) then
      raise exception 'ほかの表の置き場所が入っています' using errcode = '22023';
    end if;
    if coalesce(v_cell->>'day_kind', '') not in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun') then
      raise exception '曜日の指定が正しくありません' using errcode = '22023';
    end if;
    perform public.kids_shift_check_items(v_cell->'items', v_board);
  end loop;

  if v_from < v_today and coalesce((p_payload->>'confirm_past')::boolean, false) is not true then
    return jsonb_build_object('ok', false, 'reason', 'past_confirm');
  end if;

  -- 🚨 保存・案・決定の3つで同じロックを使う（レビュー K5）。表が違っても同じロック（取り合いは起きないほど少ない）
  perform pg_advisory_xact_lock(hashtext('kids_shift_save'));
  if coalesce(p_payload->>'base_token', '') <> public.kids_shift_token(v_board) then
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
$function$;

-- ════════════════════════════════════════════════════════════
-- 8. 案（作るときに board。あとの操作は案の board を使う。上限は表ごとに数える）
-- ════════════════════════════════════════════════════════════

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
begin
  if not public.can_manage_admin_tab('shift_patterns') then
    raise exception 'シフト表の案を保存する権限がありません' using errcode = '42501';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception '保存する内容がありません' using errcode = '22023';
  end if;
  v_op := coalesce(p_payload->>'op', '');
  if v_op not in ('create', 'update', 'cells', 'archive') then
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

-- ════════════════════════════════════════════════════════════
-- 9. 決定（token は案の表のもの。写すのは copy_items）
-- ════════════════════════════════════════════════════════════

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

-- ════════════════════════════════════════════════════════════
-- 10. 権限
--   画面から呼ぶ（authenticated）：token・save・plan_save・plan_decide
--   中で使うだけ（だれにも直接は呼ばせない）：check_items・put_items・copy_items・open_version・cell_sig・payload_sig
--   🚨 Supabase は新しい関数に anon・authenticated の権限を自動で付ける。from public だけでは外れない
-- ════════════════════════════════════════════════════════════

revoke execute on function public.kids_shift_token(text) from public, anon;
grant execute on function public.kids_shift_token(text) to authenticated;
revoke execute on function public.kids_shift_save(jsonb) from public, anon;
grant execute on function public.kids_shift_save(jsonb) to authenticated;
revoke execute on function public.kids_shift_plan_save(jsonb) from public, anon;
grant execute on function public.kids_shift_plan_save(jsonb) to authenticated;
revoke execute on function public.kids_shift_plan_decide(jsonb) from public, anon;
grant execute on function public.kids_shift_plan_decide(jsonb) to authenticated;

revoke execute on function public.kids_shift_check_items(jsonb, text) from public, anon, authenticated;
revoke execute on function public.kids_shift_put_items(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.kids_shift_copy_items(uuid, uuid, uuid) from public, anon, authenticated;
revoke execute on function public.kids_shift_open_version(uuid, text, date) from public, anon, authenticated;
revoke execute on function public.kids_shift_cell_sig(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.kids_shift_payload_sig(jsonb) from public, anon, authenticated;
revoke execute on function public.kids_shift_places_guard() from public, anon, authenticated;
revoke execute on function public.kids_shift_row_kinds_guard() from public, anon, authenticated;
