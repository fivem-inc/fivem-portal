-- 出張報告から残業申請・勤務変更をつくる（2026-10-14 ユーザー確定・計画は docs/計画-出張報告から申請.md）
-- ① 列を足す
--   ・master_options.short_label … シフト表に出す短い名前（出張の行き先だけ・行き先ごとに1つ）
--   ・kids_shift_items.trip_location_id … シフト表の出張（大人）・園指導（こども）の行き先（行き先リストの行の id）
--   ・business_trip_reports.location_option_id … 出張報告でリストから選んだ行き先（行の id）。名前は後から直されるので id で照らし合わせる
--   ・overtime_reports / shift_reports.from_trip_date … 出張報告から作った申請の印（表示だけ。受理なしの判定には使わない）
--   ・overtime_reports.trip_review_reason … 出張報告から作った申請で、受理が要った理由（上長の画面に出す）
--   ・app_settings trip_apply_start … 「出張の申請がまだの日」を出し始める日（空＝まだ出さない）
-- ② シフト表の照合（cell_sig / payload_sig）・保存（put_items / copy_items）・入力チェック（check_items）に行き先を足す
--   🚨 本番の実定義から起こした。照合には値があるときだけ足す（split_time と同じ）。足さないと開いている案がすべて食い違いになる
-- ③ 関数：短い名前を直す／まだの日の一覧／受理なしの判定（enforce_overtime_self_confirm に印 app.ot_trip_rostered）
begin;

alter table public.master_options add column if not exists short_label text;
alter table public.master_options drop constraint if exists master_options_short_label_len;
alter table public.master_options add constraint master_options_short_label_len
  check (short_label is null or char_length(short_label) between 1 and 20);
comment on column public.master_options.short_label is
  'シフト表に出す短い名前（出張の行き先 trip_location_* だけ）。空なら value をそのまま出す。2026-10-14';

alter table public.kids_shift_items add column if not exists trip_location_id uuid
  references public.master_options(id) on delete set null;
comment on column public.kids_shift_items.trip_location_id is
  '出張（大人 trip）・園指導（こども garden）の行き先（行き先リストの行）。出張報告と照らし合わせて受理なしを決める。2026-10-14';

alter table public.business_trip_reports add column if not exists location_option_id uuid
  references public.master_options(id) on delete set null;
comment on column public.business_trip_reports.location_option_id is
  '行き先をリストから選んだときの行（自分で入れた行き先は空）。リストの名前を直しても照らし合わせられるように id で持つ。2026-10-14';

alter table public.overtime_reports add column if not exists from_trip_date date;
alter table public.overtime_reports add column if not exists trip_review_reason text;
alter table public.shift_reports add column if not exists from_trip_date date;
comment on column public.overtime_reports.from_trip_date is '出張報告から作った申請の印（表示だけ・判定には使わない）。2026-10-14';
comment on column public.overtime_reports.trip_review_reason is '出張報告から作った申請で受理が要った理由（overtime_confirm_trip_rostered が書く）。2026-10-14';
comment on column public.shift_reports.from_trip_date is '出張報告から作った申請の印（表示だけ）。2026-10-14';

insert into public.app_settings (key, value, updated_at)
values ('trip_apply_start', '""'::jsonb, now())
on conflict (key) do nothing;

-- ── ② シフト表に行き先（本番の実定義から起こした・足したのは trip_location_id の行だけ） ──
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
                   else '' end
           -- 🚨 2026-10-14 追加。cell_sig と同じ形（行き先があるときだけ足す）
           || case when nullif(x.value->>'trip_location_id', '') is not null then '/@' || (x.value->>'trip_location_id') else '' end as line
      from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) with ordinality as x(value, ord)
  ) z;
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
    insert into public.kids_shift_item_people (item_id, user_id, role, start_time, end_time, sort_order)
    select v_id, (y.value->>'user_id')::uuid, coalesce(nullif(y.value->>'role', ''), 'lead'),
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
      if jsonb_typeof(v_person) <> 'object' or coalesce(v_person->>'user_id', '') !~ '^[0-9a-fA-F-]{36}$' then
        raise exception '人の指定が正しくありません' using errcode = '22023';
      end if;
      if not exists (select 1 from public.profiles p where p.id = (v_person->>'user_id')::uuid) then
        raise exception 'スタッフが見つかりません（削除された可能性があります）' using errcode = 'P0002';
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
       <> (select count(distinct (y.value->>'user_id') || ':' || coalesce(nullif(y.value->>'role', ''), 'lead'))
             from jsonb_array_elements(coalesce(v_item->'people', '[]'::jsonb)) y) then
      raise exception '同じ行に同じ人が同じ役割で2回入っています' using errcode = '22023';
    end if;
  end loop;
end;
$function$;

-- ── 自己受理の決まりに、出張の受理なしの印（app.ot_trip_rostered）を足した（本番の実定義から） ──
CREATE OR REPLACE FUNCTION public.enforce_overtime_self_confirm()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- サーバー（cron・Edge Function・service_role）
  if auth.uid() is null then return new; end if;
  -- 予定どおりの実績報告（overtime_confirm_as_planned の中だけ立つ印・2026-10-13）
  if coalesce(current_setting('app.ot_as_planned', true), '') = 'on' then return new; end if;
  -- シフト表どおりの出張（overtime_confirm_trip_rostered の中だけ立つ印・2026-10-14）
  if coalesce(current_setting('app.ot_trip_rostered', true), '') = 'on' then return new; end if;
  -- 本人以外（上長・管理者が他人の申請を受理する）
  if new.applicant_id is distinct from auth.uid() then return new; end if;
  -- 自動計上（休暇由来など）は対象外
  if new.entry_type is distinct from 'manual' then return new; end if;
  -- 確定・事前受理に「する」ときだけ見る
  if new.status not in ('confirmed', 'request_confirmed') then return new; end if;
  if tg_op = 'UPDATE' and old.status = new.status then return new; end if;
  -- マネージャー以上（管理者を含む）は自己受理できる
  if is_manager_plus() then return new; end if;
  -- だれでも自分で確定できるもの：「残業なし」の実績報告／「打刻ズレ」（どちらも差分0）
  if new.status = 'confirmed' and coalesce(new.diff_minutes, 0) = 0
     and (coalesce(cardinality(new.application_types), 0) = 0 or new.application_types = array['clock_only']::text[]) then
    return new;
  end if;
  raise exception '自分で受理（自己受理）できるのはマネージャー以上です。申請先を選んで送ってください'
    using errcode = '42501';
end;
$function$;

-- ── ③-1 短い名前を直す（シフト表の画面から・その場で保存。シフト表の［保存］とは別） ──
-- 🚨 master_options には書き込みのポリシーが無い（読むだけ）。シフト表を直せる人（shift_patterns の権限）と管理者だけ
create or replace function public.master_option_set_short_label(p_id uuid, p_label text)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_label text := nullif(btrim(coalesce(p_label, '')), '');
begin
  if auth.uid() is null
     or not (coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false) or public.can_manage_admin_tab('shift_patterns')) then
    raise exception 'シフト表を直せる人だけが変えられます' using errcode = '42501';
  end if;
  if v_label is not null and char_length(v_label) > 20 then
    raise exception '表の名前は20文字までです' using errcode = '22023';
  end if;
  update public.master_options set short_label = v_label
   where id = p_id and category like 'trip\_location\_%';
  if not found then
    raise exception '行き先が見つかりません（リストから消された可能性があります）' using errcode = 'P0002';
  end if;
end;
$function$;
revoke execute on function public.master_option_set_short_label(uuid, text) from public;
revoke execute on function public.master_option_set_short_label(uuid, text) from anon;
grant execute on function public.master_option_set_short_label(uuid, text) to authenticated;

-- ── ③-2 出張報告を日ごとにする（中で使うだけ・画面からは呼べない） ──
-- 到着→次の終了を1つの出張とみなす。日本時間の日付で数え、終了が到着から7日以内なら間の日を全部出す（8日以上は報告し忘れとみなして到着の日だけ）。
-- 到着が続いたら前の到着は「終了なし」、到着の無い終了は「到着なし」。1日に2つあるときは呼び出し側で先の1つにする
create or replace function public.trip_days_of(p_user uuid, p_from date, p_to date)
returns table (d date, span_start date, span_end date, loc text, loc_id uuid, arrive_at timestamptz, finish_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  r record;
  -- 終了を待っている到着（🚨 record にしない：plpgsql は and を途中で止めないので、まだ入っていない record を読んで落ちる）
  p_bd  date;
  p_at  timestamptz;
  p_loc text;
  p_lid uuid;
  dd date;
begin
  for r in
    select b.report_type, b.created_at, (b.created_at at time zone 'Asia/Tokyo')::date as bd, b.location, b.location_option_id
      from business_trip_reports b
     where b.user_id = p_user
       and b.created_at >= ((p_from - 8)::timestamp at time zone 'Asia/Tokyo')
       and b.created_at <  ((p_to + 1)::timestamp at time zone 'Asia/Tokyo')
     order by b.created_at
  loop
    if r.report_type = '到着' then
      if p_bd is not null and p_bd between p_from and p_to then
        d := p_bd; span_start := p_bd; span_end := p_bd; loc := p_loc; loc_id := p_lid;
        arrive_at := p_at; finish_at := null; return next;
      end if;
      p_bd := r.bd; p_at := r.created_at; p_loc := r.location; p_lid := r.location_option_id;
    else
      if p_bd is not null and r.bd - p_bd between 0 and 7 then
        dd := p_bd;
        while dd <= r.bd loop
          if dd between p_from and p_to then
            d := dd; span_start := p_bd; span_end := r.bd; loc := p_loc; loc_id := p_lid;
            arrive_at := case when dd = p_bd then p_at end;
            finish_at := case when dd = r.bd then r.created_at end;
            return next;
          end if;
          dd := dd + 1;
        end loop;
      else
        if p_bd is not null and p_bd between p_from and p_to then
          d := p_bd; span_start := p_bd; span_end := p_bd; loc := p_loc; loc_id := p_lid;
          arrive_at := p_at; finish_at := null; return next;
        end if;
        if r.bd between p_from and p_to then
          d := r.bd; span_start := r.bd; span_end := r.bd; loc := r.location; loc_id := r.location_option_id;
          arrive_at := null; finish_at := r.created_at; return next;
        end if;
      end if;
      p_bd := null;
    end if;
  end loop;
  if p_bd is not null and p_bd between p_from and p_to then
    d := p_bd; span_start := p_bd; span_end := p_bd; loc := p_loc; loc_id := p_lid;
    arrive_at := p_at; finish_at := null; return next;
  end if;
end;
$function$;
revoke execute on function public.trip_days_of(uuid, date, date) from public;
revoke execute on function public.trip_days_of(uuid, date, date) from anon;
revoke execute on function public.trip_days_of(uuid, date, date) from authenticated;

-- ── ③-3 本人の「出張の申請がまだの日」 ──
-- 出す範囲：trip_apply_start（空なら何も出さない）と「前の給与期間の初め」の遅いほう 〜 今日
-- 出さない日：残業＝取消以外の申請がある日・「定時」の記録がある日／勤務変更（パート）＝行が1つでもある日（取消を含む・同じ日は出し直せないため）
-- 🚨 本人の分だけ（出張報告を見る権限がある人でも他人の分は返さない）
create or replace function public.my_trip_pending_days()
returns table (work_date date, form text, span_start date, span_end date, location text,
               location_option_id uuid, arrive_at timestamptz, finish_at timestamptz)
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
  v_start date;
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_from date;
  v_form text;
begin
  if v_uid is null then return; end if;
  select nullif(value #>> '{}', '')::date into v_start from app_settings where key = 'trip_apply_start';
  if v_start is null or v_start > v_today then return; end if;
  v_from := greatest(v_start, calc_pay_period_start(calc_pay_period_start(v_today) - 1));
  select case when employment_type = 'パート' then 'shift_report' else 'overtime' end into v_form from profiles where id = v_uid;
  return query
  select distinct on (t.d) t.d, coalesce(v_form, 'overtime'), t.span_start, t.span_end, t.loc, t.loc_id, t.arrive_at, t.finish_at
    from public.trip_days_of(v_uid, v_from, v_today) t
   where (coalesce(v_form, 'overtime') = 'overtime'
          and not exists (select 1 from overtime_reports o where o.applicant_id = v_uid and o.work_date = t.d and o.status <> 'cancelled')
          and not exists (select 1 from overtime_day_checks k where k.user_id = v_uid and k.work_date = t.d))
      or (v_form = 'shift_report'
          and not exists (select 1 from shift_reports s where s.applicant_id = v_uid and s.work_date = t.d))
   order by t.d, t.arrive_at nulls last, t.finish_at nulls last;
end;
$function$;
revoke execute on function public.my_trip_pending_days() from public;
revoke execute on function public.my_trip_pending_days() from anon;
grant execute on function public.my_trip_pending_days() to authenticated;

-- ── ③-4 出張報告から作った残業申請を、シフト表どおりなら受理なしで確認済みにする ──
-- 画面が送ったあとに呼ぶ。🚨 画面が書いた値（diff_minutes・normal_shift など）は信じず、DB で確かめる：
--   本人・手入力・実績報告済み（reported）・申請先が本人以外・from_trip_date がある
--   その日に出張報告があり、行き先がリストの行（location_option_id）
--   決定済みのシフト表（大人の出張・こどもの園指導）に、その曜日・その人・同じ行き先がある（役割は問わない・2026-10-14 ユーザー確定）
--   申請の勤務地が、その行き先の名前と同じ（空白・全角半角は無視）
--   種別が「勤務地変更」だけ・いつものシフトを手で直していない
--   実績の時間帯が、その日のシフト（weekly_shift_patterns・会社カレンダーで曜日を決める）と同じ
-- 合わないときは trip_review_reason に理由を書いて false（上長の画面に出す）
create or replace function public.overtime_confirm_trip_rostered(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_r     overtime_reports%rowtype;
  v_trip  record;
  v_item  record;
  v_pat   weekly_shift_patterns%rowtype;
  v_kind  text;
  v_dk    text;
  v_dow   text;
  v_loc   text;
  v_label text;
  v_reason text;
  v_same  boolean;
  v_name  text;
  v_site  boolean;
  v_md    text;
  v_has_item boolean;
begin
  select * into v_r from overtime_reports where id = p_id for update;
  if not found then return jsonb_build_object('confirmed', false, 'reason', null); end if;
  if v_r.applicant_id is distinct from auth.uid() or v_r.from_trip_date is null
     or v_r.entry_type <> 'manual' or v_r.status <> 'reported'
     or v_r.reviewer_id is null or v_r.reviewer_id = v_r.applicant_id then
    return jsonb_build_object('confirmed', false, 'reason', null);
  end if;

  v_dow := (array['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from v_r.work_date)::int + 1];
  select * into v_trip from public.trip_days_of(v_r.applicant_id, v_r.work_date, v_r.work_date) t
   order by (t.loc_id is null), t.arrive_at nulls last limit 1;

  if not found then
    v_reason := 'この日の出張報告がありません';
  elsif v_trip.loc_id is null then
    v_reason := '行き先が行き先リストにありません';
  else
    select i.trip_location_id, coalesce(m.short_label, m.value, i.class_name) as label into v_item
      from kids_shift_items i
      join kids_shift_cells c on c.id = i.cell_id
      join kids_shift_places pl on pl.id = c.place_id
      left join master_options m on m.id = i.trip_location_id
     where c.day_kind = v_dow and c.valid_from <= v_r.work_date and (c.valid_to is null or c.valid_to >= v_r.work_date)
       and pl.active and not i.is_none
       and ((pl.board = 'adult' and i.kind_key = 'trip') or (pl.board = 'kids' and i.kind_key = 'garden'))
       and exists (select 1 from kids_shift_item_people pe where pe.item_id = i.id and pe.user_id = v_r.applicant_id)
     order by (i.trip_location_id is not distinct from v_trip.loc_id) desc
     limit 1;
    v_has_item := found;
    select value into v_loc from master_options where id = v_trip.loc_id;
    if not v_has_item then
      v_reason := 'シフト表にこの日の出張がありません';
    elsif v_item.trip_location_id is distinct from v_trip.loc_id then
      v_reason := '行き先がシフト表と違います（シフト表：' || coalesce(v_item.label, '行き先なし') || '）';
    elsif lower(regexp_replace(normalize(coalesce(v_r.location, ''), NFKC), '\s', '', 'g'))
          <> lower(regexp_replace(normalize(coalesce(v_loc, ''), NFKC), '\s', '', 'g')) then
      v_reason := '申請の勤務地が出張の行き先と違います';
    elsif coalesce(v_r.application_types, '{}') <> array['location_change']::text[] then
      v_reason := 'シフトの時間と違います（残業・早出・休日出勤など）';
    elsif coalesce((v_r.normal_shift->>'manual_override')::boolean, false) then
      v_reason := 'いつものシフトを手で直しています';
    else
      -- その日のシフト（sync_overtime_from_leave と同じ探し方）
      select kind into v_kind from company_calendar where date = v_r.work_date;
      v_dk := case when v_kind = 'closed_all' then 'holiday'
                   when v_kind in ('work_on_closed', 'work_on_closed_encouraged') then 'work_on_closed'
                   else v_dow end;
      select * into v_pat from weekly_shift_patterns
       where user_id = v_r.applicant_id and day_kind = v_dk and valid_from <= v_r.work_date
         and (valid_to is null or valid_to >= v_r.work_date)
       order by valid_from desc limit 1;
      if v_pat.id is null and v_dk = 'work_on_closed' then
        select * into v_pat from weekly_shift_patterns
         where user_id = v_r.applicant_id and day_kind = v_dow and valid_from <= v_r.work_date
           and (valid_to is null or valid_to >= v_r.work_date)
         order by valid_from desc limit 1;
      end if;
      if v_pat.id is null or v_pat.start_time is null or coalesce(v_pat.labor_minutes, 0) <= 0 then
        v_reason := 'この日のシフトがありません';
      else
        with bands as (
          select (extract(epoch from v_pat.start_time) / 60)::int as s, (extract(epoch from v_pat.end_time) / 60)::int as e
          union all
          select (extract(epoch from v_pat.start_time2) / 60)::int, (extract(epoch from v_pat.end_time2) / 60)::int
           where v_pat.start_time2 is not null and v_pat.end_time2 is not null
        ), act as (
          select start_min as s, end_min as e from overtime_report_segments where report_id = p_id and phase = 'actual'
        )
        select (select count(*) from act) > 0
           and not exists ((select s, e from bands except all select s, e from act)
                           union all
                           (select s, e from act except all select s, e from bands))
          into v_same;
        if not coalesce(v_same, false) then
          v_reason := '実際の時間がシフトの時間と違います';
        end if;
      end if;
    end if;
  end if;

  if v_reason is not null then
    update overtime_reports set trip_review_reason = v_reason where id = p_id;
    return jsonb_build_object('confirmed', false, 'reason', v_reason);
  end if;

  -- 確認済みにする（この中だけ自己受理の決まりを通す）
  perform set_config('app.ot_trip_rostered', 'on', true);
  update overtime_reports
     set status = 'confirmed', confirmed_by = v_r.reviewer_id, confirmed_at = now(), trip_review_reason = null
   where id = p_id and status = 'reported';
  perform set_config('app.ot_trip_rostered', 'off', true);

  insert into overtime_report_history (report_id, changed_by, change_summary, snapshot)
  values (p_id, auth.uid(), 'シフト表どおりの出張のため、受理を省いて確認済み（出張報告あり）', to_jsonb(v_r));

  -- 上長へベルだけ（プッシュなし・予定どおりの実績と同じ扱い）。設定 overtime:new_request（サイト）が切られていれば送らない
  select enabled into v_site from notification_settings where event_key = 'overtime:new_request' and channel = 'site';
  if coalesce(v_site, true) then
    select name into v_name from profiles where id = v_r.applicant_id;
    v_md := extract(month from v_r.work_date)::int || '/' || extract(day from v_r.work_date)::int
            || '（' || (array['日','月','火','水','木','金','土'])[extract(dow from v_r.work_date)::int + 1] || '）';
    select coalesce(short_label, value) into v_label from master_options where id = v_trip.loc_id;
    insert into notifications (user_id, message, sub_message, source_type, reference_id, event_key, read)
    values (v_r.reviewer_id,
            '🕐 ' || coalesce(v_name, '') || 'さんの' || v_md || 'の出張（' || coalesce(v_label, v_r.location, '') || '）はシフト表どおりでした（受理は不要です）',
            null, null, null, null, false);
  end if;

  return jsonb_build_object('confirmed', true, 'reason', null);
end;
$function$;
revoke execute on function public.overtime_confirm_trip_rostered(uuid) from public;
revoke execute on function public.overtime_confirm_trip_rostered(uuid) from anon;
grant execute on function public.overtime_confirm_trip_rostered(uuid) to authenticated;

commit;
