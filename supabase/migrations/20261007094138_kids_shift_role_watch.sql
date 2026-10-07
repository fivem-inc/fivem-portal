-- 人の役割「見守り」（watch）を足す（2026-10-07 ユーザー確定）。紙の「14:40〜1班【森本】川井」の【 】＝見守り。
-- 表・PDF は紙と同じく「1班【森本】」と出す。必要な人数には数えない（担当だけを数える・（ ）と同じ）。共通の行では他業務に出す。
-- 🚨 kids_shift_check_items は本番の pg_get_functiondef（2026-10-07）から起こし、役割の2行だけ変えた

begin;

alter table public.kids_shift_item_people drop constraint if exists kids_shift_item_people_role_check;
alter table public.kids_shift_item_people
  add constraint kids_shift_item_people_role_check
  check (role in ('lead', 'onduty', 'support', 'second', 'second_support', 'assist', 'watch'));

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

revoke execute on function public.kids_shift_check_items(jsonb, text) from public, anon, authenticated;

commit;
