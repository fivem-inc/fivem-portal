-- ============================================================
-- 2026-10-20  勤務表の勤務校に出張の行き先も入れられるようにする（ユーザー確定 案B）
-- ============================================================
-- 画面（e8b23768）は出張の行き先を選べるようにしたが、保存の関数 shift_pattern_fields が「校（workplace）」だけを通していて、
-- 「「JEUGIA 四条」という校はありません」で保存できなかった（社長の実機）。本番の実定義（2026-10-20）から、確かめる1か所だけ直した。
-- 🚨 終了した行き先も通す（前に入れた勤務表を保存し直したときに止めないため。選択肢には出ない）
-- ロールバック手順：この関数を、作業用フォルダ（D ドライブの fivem-work の rollback-20261020-encouragement）に控えた def_loc_shift_pattern_fields.sql の定義で作り直す

CREATE OR REPLACE FUNCTION public.shift_pattern_fields(p_segments jsonb)
 RETURNS TABLE(start_time time without time zone, end_time time without time zone, start_time2 time without time zone, end_time2 time without time zone, location text, break_minutes integer, labor_minutes integer)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
      -- 2026-10-20：勤務表の勤務校は「校」に加えて出張の行き先（区分・行き先リスト管理の trip_location_◯◯）も選べる（ユーザー確定 案B・画面は lib/shiftRosterApi の placeGroups）
      if not exists (select 1 from public.master_options mo
                      where (mo.category = 'workplace' or mo.category like 'trip_location_%')
                        and mo.value = btrim(v_part)) then
        raise exception '「%」という勤務場所はありません', v_part using errcode = '22023';
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
$function$;
