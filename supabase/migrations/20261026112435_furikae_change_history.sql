-- 振替休日 段6 の直し（2026-10-26 レビュー 穴D）：furikae_change_apply で新しくできた休日出勤・勤務地変更にも「どこから来たか」の履歴を1行ずつ残す
-- 🚨 20261026084104 の furikae_change_apply に2か所足しただけ（権限の revoke もそのまま）

-- 変更を当てる（service だけ）。戻り値 {holiday_id, location_id}
create or replace function public.furikae_change_apply(p_id uuid, p_actor uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  r        overtime_reports%rowtype;
  v_today  date := (now() at time zone 'Asia/Tokyo')::date;
  v_actual boolean;
  v_hol    uuid;
  v_loc    uuid;
  v_s int; v_e int; v_s2 int; v_e2 int;
  v_dk text;
begin
  select * into r from overtime_reports where id = p_id for update;
  if not found then raise exception 'FURIKAE_CHANGE|対象の申請が見つかりません'; end if;
  if r.entry_type <> 'manual' or not ('furikae_off' = any (coalesce(r.application_types, '{}'))) or r.furikae_origin_date is null then
    raise exception 'FURIKAE_CHANGE|振替休日の申請ではありません';
  end if;
  if r.furikae_change_requested_at is null then raise exception 'FURIKAE_CHANGE|変更の依頼がありません'; end if;
  if r.status not in ('requested', 'request_confirmed', 'reported', 'confirmed') then raise exception 'FURIKAE_CHANGE|この状態では変えられません'; end if;
  if r.furikae_origin_start is null or r.furikae_origin_end is null then raise exception 'FURIKAE_CHANGE|振替元の時刻がありません'; end if;

  insert into overtime_report_history (report_id, changed_by, change_kind, change_summary, snapshot)
  values (r.id, p_actor, 'cancelled',
          '振替休日の変更（休む日を出勤に・振替元は休日出勤）：' || coalesce(r.furikae_change_reason, ''), to_jsonb(r));

  -- ① 振替休日を取り消す（先に取り消さないと、振替元の日の休日出勤が二重計上の見張りで止まる）
  update overtime_reports set status = 'cancelled' where id = r.id;

  -- ② 振替元の日の休日出勤。振替元の実際の時刻が決まっているなら確認済み、まだなら事前申請 受理済み（あとで実績を報告）
  v_actual := (not coalesce(r.furikae_report_needed, false)) or r.status = 'confirmed';
  v_s := extract(hour from r.furikae_origin_start)::int * 60 + extract(minute from r.furikae_origin_start)::int;
  v_e := extract(hour from r.furikae_origin_end)::int * 60 + extract(minute from r.furikae_origin_end)::int;
  if v_e <= v_s then v_e := v_e + 1440; end if;
  v_dk := (array['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from r.furikae_origin_date)::int + 1];
  insert into overtime_reports (applicant_id, submitted_by, reviewer_id, work_date, pay_period_start, entry_type, is_post_hoc, status,
    normal_shift, break_minutes, break_manual, labor_minutes, diff_minutes, legal_warning, reason, change_reason, location, application_types,
    request_confirmed_at, confirmed_by, confirmed_at)
  values (r.applicant_id, r.applicant_id, r.reviewer_id, r.furikae_origin_date, public.calc_pay_period_start(r.furikae_origin_date), 'manual',
    r.furikae_origin_date < v_today, case when v_actual then 'confirmed' else 'request_confirmed' end,
    jsonb_build_object('day_kind', v_dk, 'calendar_kind', null, 'start_time', null, 'end_time', null, 'start_time2', null, 'end_time2', null,
                       'break_minutes', 0, 'labor_minutes', 0, 'location', null),
    coalesce(r.furikae_origin_break_minutes, 0), false, coalesce(r.furikae_origin_labor_minutes, 0), coalesce(r.furikae_origin_labor_minutes, 0), false,
    coalesce(r.reason, ''), '振替休日から変更（' || coalesce(r.furikae_change_reason, '') || '）', r.furikae_origin_location, array['holiday_work'],
    coalesce(r.request_confirmed_at, now()), case when v_actual then p_actor end, case when v_actual then now() end)
  returning id into v_hol;
  insert into overtime_report_segments (report_id, phase, seg_no, start_min, end_min) values (v_hol, 'planned', 1, v_s, v_e);
  if v_actual then
    insert into overtime_report_segments (report_id, phase, seg_no, start_min, end_min) values (v_hol, 'actual', 1, v_s, v_e);
  end if;
  -- どこから来たかの履歴（2026-10-26 レビュー 穴D）
  insert into overtime_report_history (report_id, changed_by, change_kind, change_summary, snapshot)
  select v_hol, p_actor, 'edited', '振替休日（元の申請 ' || r.id || '）の変更で作成：振替元の日の休日出勤', to_jsonb(x) from overtime_reports x where x.id = v_hol;

  -- ③ 休む日がいつもと違う場所なら勤務地変更（時間は休む日の通常シフトのまま）
  if nullif(trim(coalesce(r.furikae_change_location, '')), '') is not null and nullif(r.normal_shift->>'start_time', '') is not null
     and nullif(r.normal_shift->>'end_time', '') is not null then
    insert into overtime_reports (applicant_id, submitted_by, reviewer_id, work_date, pay_period_start, entry_type, is_post_hoc, status,
      normal_shift, break_minutes, break_manual, labor_minutes, diff_minutes, legal_warning, reason, change_reason, location, application_types,
      request_confirmed_at, confirmed_by, confirmed_at)
    values (r.applicant_id, r.applicant_id, r.reviewer_id, r.work_date, public.calc_pay_period_start(r.work_date), 'manual',
      r.work_date < v_today, case when r.work_date < v_today then 'confirmed' else 'request_confirmed' end,
      r.normal_shift, coalesce((r.normal_shift->>'break_minutes')::int, 0), false, coalesce((r.normal_shift->>'labor_minutes')::int, 0), 0, false,
      '振替休日から変更（休む日を出勤に・' || coalesce(r.furikae_change_reason, '') || '）', null, trim(r.furikae_change_location), array['location_change'],
      now(), case when r.work_date < v_today then p_actor end, case when r.work_date < v_today then now() end)
    returning id into v_loc;
    v_s := split_part(r.normal_shift->>'start_time', ':', 1)::int * 60 + split_part(r.normal_shift->>'start_time', ':', 2)::int;
    v_e := split_part(r.normal_shift->>'end_time', ':', 1)::int * 60 + split_part(r.normal_shift->>'end_time', ':', 2)::int;
    insert into overtime_report_segments (report_id, phase, seg_no, start_min, end_min) values (v_loc, 'planned', 1, v_s, v_e);
    if nullif(r.normal_shift->>'start_time2', '') is not null and nullif(r.normal_shift->>'end_time2', '') is not null then
      v_s2 := split_part(r.normal_shift->>'start_time2', ':', 1)::int * 60 + split_part(r.normal_shift->>'start_time2', ':', 2)::int;
      v_e2 := split_part(r.normal_shift->>'end_time2', ':', 1)::int * 60 + split_part(r.normal_shift->>'end_time2', ':', 2)::int;
      insert into overtime_report_segments (report_id, phase, seg_no, start_min, end_min) values (v_loc, 'planned', 2, v_s2, v_e2);
    end if;
    if r.work_date < v_today then
      insert into overtime_report_segments (report_id, phase, seg_no, start_min, end_min)
        select v_loc, 'actual', seg_no, start_min, end_min from overtime_report_segments where report_id = v_loc and phase = 'planned';
    end if;
    insert into overtime_report_history (report_id, changed_by, change_kind, change_summary, snapshot)
    select v_loc, p_actor, 'edited', '振替休日（元の申請 ' || r.id || '）の変更で作成：休む日の勤務地変更', to_jsonb(x) from overtime_reports x where x.id = v_loc;
  end if;

  return jsonb_build_object('holiday_id', v_hol, 'location_id', v_loc);
end;
$$;
revoke execute on function public.furikae_change_apply(uuid, uuid) from public;
revoke execute on function public.furikae_change_apply(uuid, uuid) from anon;
revoke execute on function public.furikae_change_apply(uuid, uuid) from authenticated;
grant execute on function public.furikae_change_apply(uuid, uuid) to service_role;
