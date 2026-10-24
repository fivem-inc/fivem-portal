-- パートの方の「予定どおりの出張」には勤務変更の下書きを出さない（2026-10-24 ユーザー確定 案A・計画 docs/計画-出張の下書き-予定どおりの出張.md）
-- UI/UX とシニアエンジニアの2体でレビューし、ユーザーが3つを決めた：
--   ① 時刻の幅：到着はシフトの開始の30分前から認める・終了はシフトの終わりまで（幅なし。終わりを過ぎたら残業の可能性があるので出す）
--   ② 到着だけ（終了を送っていない）の日も、到着が時間内なら出さない（到着を送ったあとに「終了の報告を送ってください」と出す）
--   ③ 区分が「出張」「園指導」のときだけ（試合・イベント下見・その他はいつも出す）
-- 🚨 正社員の方（残業申請の下書き）は今までどおり。my_trip_pending_days の残業申請の枝は触っていない
-- 🚨 迷う日はすべて「下書きを出す」側に倒す（泊まり・報告なし・手入力の行き先・シフトなし・日をまたぐシフト・労働時間0）
begin;

-- ── 登録シフト（その日に有効な行だけ）。休館日は holiday・社員出勤日は work_on_closed、無ければ曜日の行 ──
--   overtime_confirm_trip_rostered（本番）・画面の resolveDayKind／resolveNormalShift と同じ決まり。
--   🚨 画面の findPatternRow の「有効な行が無ければ近い期間の行」はまねしない（(317) で間違った知らせが出た原因）
create or replace function public.registered_shift_of(p_user uuid, p_date date)
returns public.weekly_shift_patterns
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_kind text;
  v_dow  text := (array['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from p_date)::int + 1];
  v_dk   text;
  v_pat  public.weekly_shift_patterns%rowtype;
begin
  select kind into v_kind from company_calendar where date = p_date;
  v_dk := case when v_kind = 'closed_all' then 'holiday'
               when v_kind in ('work_on_closed', 'work_on_closed_encouraged') then 'work_on_closed'
               else v_dow end;
  select * into v_pat from weekly_shift_patterns
   where user_id = p_user and day_kind = v_dk and valid_from <= p_date and (valid_to is null or valid_to >= p_date)
   order by valid_from desc limit 1;
  if v_pat.id is null and v_dk = 'work_on_closed' then
    select * into v_pat from weekly_shift_patterns
     where user_id = p_user and day_kind = v_dow and valid_from <= p_date and (valid_to is null or valid_to >= p_date)
     order by valid_from desc limit 1;
  end if;
  return v_pat;
end;
$function$;
comment on function public.registered_shift_of(uuid, date) is
  'その日に有効な登録シフトの行（休館日・社員出勤日の扱いは overtime_confirm_trip_rostered と同じ）。内部用。2026-10-24';

-- ── trip_days_of の1行が「予定どおりの出張」か（パートの方の下書きを出さない判定・ここ1か所） ──
create or replace function public.trip_day_on_roster(
  p_user uuid, p_d date, p_span_start date, p_span_end date,
  p_loc_id uuid, p_arrive_at timestamptz, p_finish_at timestamptz)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_pat   public.weekly_shift_patterns%rowtype;
  v_dow   text := (array['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from p_d)::int + 1];
  v_s     int;
  v_e     int;
  v_arr   int;
  v_fin   int;
  v_val   text;
  v_short text;
  v_part  text;
  v_planned boolean := false;
  norm text;
begin
  -- 泊まり・報告の無い日（泊まりの途中）・手入力の行き先は対象外（出す）
  if p_span_start is distinct from p_span_end or (p_arrive_at is null and p_finish_at is null) or p_loc_id is null then
    return false;
  end if;
  -- ③ 区分は「出張」「園指導」だけ（その日の報告の行の区分を見る。どれか1つでも違えば出す）
  if exists (select 1 from business_trip_reports b
              where b.user_id = p_user and b.created_at in (p_arrive_at, p_finish_at)
                and coalesce(b.category, '') not in ('出張', '園指導')) then
    return false;
  end if;
  -- 登録シフト。無い・時刻が無い・労働時間0なら出す
  v_pat := public.registered_shift_of(p_user, p_d);
  if v_pat.id is null or v_pat.start_time is null or v_pat.end_time is null or coalesce(v_pat.labor_minutes, 0) <= 0 then
    return false;
  end if;
  -- 時間帯の端：帯の順番は決まっていない（帯2が朝の行がある）ので least・greatest（画面の normalShiftBands と同じ）
  v_s := extract(hour from least(v_pat.start_time, coalesce(v_pat.start_time2, v_pat.start_time)))::int * 60
       + extract(minute from least(v_pat.start_time, coalesce(v_pat.start_time2, v_pat.start_time)))::int;
  v_e := extract(hour from greatest(v_pat.end_time, coalesce(v_pat.end_time2, v_pat.end_time)))::int * 60
       + extract(minute from greatest(v_pat.end_time, coalesce(v_pat.end_time2, v_pat.end_time)))::int;
  if v_e <= v_s then return false; end if;   -- 日をまたぐシフトは対象外
  -- ② 時刻（分にそろえる・両端を含む）：到着は開始の30分前から終わりまで／終了は開始から終わりまで
  if p_arrive_at is not null then
    v_arr := extract(hour from (p_arrive_at at time zone 'Asia/Tokyo'))::int * 60 + extract(minute from (p_arrive_at at time zone 'Asia/Tokyo'))::int;
    if (p_arrive_at at time zone 'Asia/Tokyo')::date <> p_d or v_arr < v_s - 30 or v_arr > v_e then return false; end if;
  end if;
  if p_finish_at is not null then
    v_fin := extract(hour from (p_finish_at at time zone 'Asia/Tokyo'))::int * 60 + extract(minute from (p_finish_at at time zone 'Asia/Tokyo'))::int;
    if (p_finish_at at time zone 'Asia/Tokyo')::date <> p_d or v_fin < v_s or v_fin > v_e then return false; end if;
  end if;
  -- ① 行き先が予定に入っている：登録シフトの勤務地（「→」で区切った各校）か、決定済みのシフト表の出張・園指導
  select value, short_label into v_val, v_short from master_options where id = p_loc_id;
  if v_val is not null and v_pat.location is not null then
    foreach v_part in array string_to_array(v_pat.location, '→') loop
      norm := lower(regexp_replace(normalize(coalesce(v_part, ''), NFKC), '\s', '', 'g'));
      if norm <> '' and (norm = lower(regexp_replace(normalize(v_val, NFKC), '\s', '', 'g'))
                         or norm = lower(regexp_replace(normalize(coalesce(v_short, ''), NFKC), '\s', '', 'g'))) then
        v_planned := true; exit;
      end if;
    end loop;
  end if;
  if not v_planned then
    -- シフト表の照合は overtime_confirm_trip_rostered（本番）と同じ。行き先が同じものだけ
    v_planned := exists (
      select 1
        from kids_shift_items i
        join kids_shift_cells c on c.id = i.cell_id
        join kids_shift_places pl on pl.id = c.place_id
       where c.day_kind = v_dow and c.valid_from <= p_d and (c.valid_to is null or c.valid_to >= p_d)
         and pl.active and not i.is_none
         and ((pl.board = 'adult' and i.kind_key = 'trip') or (pl.board = 'kids' and i.kind_key = 'garden'))
         and i.trip_location_id = p_loc_id
         and exists (select 1 from kids_shift_item_people pe where pe.item_id = i.id and pe.user_id = p_user));
  end if;
  return v_planned;
end;
$function$;
comment on function public.trip_day_on_roster(uuid, date, date, date, uuid, timestamptz, timestamptz) is
  'trip_days_of の1行が予定どおりの出張か（パートの方の勤務変更の下書きを出さない判定・2026-10-24）。迷う日は false＝出す。内部用';

revoke execute on function public.registered_shift_of(uuid, date) from public;
revoke execute on function public.registered_shift_of(uuid, date) from anon;
revoke execute on function public.registered_shift_of(uuid, date) from authenticated;
revoke execute on function public.trip_day_on_roster(uuid, date, date, date, uuid, timestamptz, timestamptz) from public;
revoke execute on function public.trip_day_on_roster(uuid, date, date, date, uuid, timestamptz, timestamptz) from anon;
revoke execute on function public.trip_day_on_roster(uuid, date, date, date, uuid, timestamptz, timestamptz) from authenticated;

-- ── 「まだの日」（本番の実定義から起こした・足したのは勤務変更の枝の最後の1行だけ） ──
--   🚨 判定は distinct on の前の where で1行ずつにかける（同じ日に予定どおりと予定外の2組があるとき、予定外の組を残す）
CREATE OR REPLACE FUNCTION public.my_trip_pending_days()
 RETURNS TABLE(work_date date, form text, span_start date, span_end date, location text, location_option_id uuid, arrive_at timestamp with time zone, finish_at timestamp with time zone)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
          and not exists (select 1 from shift_reports s where s.applicant_id = v_uid and s.work_date = t.d)
          -- 2026-10-24：予定どおりの出張（登録シフト・シフト表に入っている行き先で、シフトの時間内）は出さない
          and not public.trip_day_on_roster(v_uid, t.d, t.span_start, t.span_end, t.loc_id, t.arrive_at, t.finish_at))
   order by t.d, t.arrive_at nulls last, t.finish_at nulls last;
end;
$function$;

-- ── 出張報告を送ったあとの1行のため：その日が「予定どおりの出張」で、まだの日に出ていないか（本人の分だけ） ──
--   🚨 まだの日に出ている組が1つでもあれば false（そちらの「下書きを作成しました」を出す）
create or replace function public.my_trip_day_on_roster(p_date date)
returns boolean
language plpgsql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null or p_date is null then return false; end if;
  if (select employment_type from profiles where id = v_uid) is distinct from 'パート' then return false; end if;
  if exists (select 1 from shift_reports s where s.applicant_id = v_uid and s.work_date = p_date) then return false; end if;
  if exists (select 1 from public.my_trip_pending_days() x where x.work_date = p_date) then return false; end if;
  return exists (
    select 1 from public.trip_days_of(v_uid, p_date, p_date) t
     where public.trip_day_on_roster(v_uid, t.d, t.span_start, t.span_end, t.loc_id, t.arrive_at, t.finish_at));
end;
$function$;
comment on function public.my_trip_day_on_roster(date) is
  '本人のその日が予定どおりの出張で、勤務変更の下書きを出していないか（出張報告を送ったあとの1行・2026-10-24）';
revoke execute on function public.my_trip_day_on_roster(date) from public;
revoke execute on function public.my_trip_day_on_roster(date) from anon;
grant execute on function public.my_trip_day_on_roster(date) to authenticated;

commit;
