-- 「シフト表どおりの出張」の判定を1か所にそろえる（2026-10-24 ユーザー指示・20261024141434 のレビューで出た「同じ判定を2か所に書かない」の続き）
-- ・シフト表（大人の出張・こどもの園指導）の照合を trip_roster_item に出し、overtime_confirm_trip_rostered（残業申請の受理なし）と
--   trip_day_on_roster（パートの方の下書きを出さない）の両方から使う
-- ・overtime_confirm_trip_rostered の登録シフトの探し方を registered_shift_of に（中身は前と同じ・本番の実定義と突き合わせ済み）
-- 🚨 動きは変えない。overtime_confirm_trip_rostered は本番の実定義から起こし、差し替えたのは上の2か所だけ
-- 🚨 同じ探し方は sync_overtime_from_leave にもまだ残っている（今回は触っていない）
begin;

create or replace function public.trip_roster_item(p_user uuid, p_date date, p_loc_id uuid)
returns table(trip_location_id uuid, label text)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  -- その日その人の、決定済みのシフト表の出張（大人）・園指導（こども）。行き先が同じものを先に1件
  select i.trip_location_id, coalesce(m.short_label, m.value, i.class_name) as label
    from kids_shift_items i
    join kids_shift_cells c on c.id = i.cell_id
    join kids_shift_places pl on pl.id = c.place_id
    left join master_options m on m.id = i.trip_location_id
   where c.day_kind = (array['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from p_date)::int + 1]
     and c.valid_from <= p_date and (c.valid_to is null or c.valid_to >= p_date)
     and pl.active and not i.is_none
     and ((pl.board = 'adult' and i.kind_key = 'trip') or (pl.board = 'kids' and i.kind_key = 'garden'))
     and exists (select 1 from kids_shift_item_people pe where pe.item_id = i.id and pe.user_id = p_user)
   order by (i.trip_location_id is not distinct from p_loc_id) desc
   limit 1;
$$;
comment on function public.trip_roster_item(uuid, date, uuid) is
  'その日その人のシフト表の出張・園指導（行き先が同じものを先に1件）。overtime_confirm_trip_rostered と trip_day_on_roster が使う。内部用。2026-10-24';
revoke execute on function public.trip_roster_item(uuid, date, uuid) from public;
revoke execute on function public.trip_roster_item(uuid, date, uuid) from anon;
revoke execute on function public.trip_roster_item(uuid, date, uuid) from authenticated;

CREATE OR REPLACE FUNCTION public.overtime_confirm_trip_rostered(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
    -- 2026-10-24：シフト表の照合は trip_roster_item 1か所に出した（trip_day_on_roster と共用・中身は前と同じ）
    select r.trip_location_id, r.label into v_item from public.trip_roster_item(v_r.applicant_id, v_r.work_date, v_trip.loc_id) r;
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
      -- その日のシフト。2026-10-24：registered_shift_of 1か所に出した（trip_day_on_roster と共用・中身は前と同じ）
      v_pat := public.registered_shift_of(v_r.applicant_id, v_r.work_date);
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
    -- シフト表の照合は trip_roster_item 1か所（overtime_confirm_trip_rostered と共用）。行き先が同じものだけ
    v_planned := exists (select 1 from public.trip_roster_item(p_user, p_d, p_loc_id) r where r.trip_location_id = p_loc_id);
  end if;
  return v_planned;
end;
$function$;

commit;
