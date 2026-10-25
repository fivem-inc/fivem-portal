-- 振替休日 段6：休む日だけ出勤に変える（振替元の休日出勤は残す・2026-10-26 ユーザー確定）。計画 docs/計画-振替休日の実績報告.md
-- ・本人が［休む日を出勤に変える（休日出勤は残す）］→ 申請先の受理（自己受理の方は押した時点）→ furikae_change_apply が
--   ①振替休日を取り消す ②振替元の日に「休日出勤」を作る ③休む日がいつもと違う場所なら「勤務地変更」を作る を1回でまとめて行う
-- ・依頼の印（furikae_change_*）を付け外しできるのは Edge Function overtime-approve（service）だけ（trg_furikae_report_state で守る）
-- 🚨 trg_furikae_report_state は 20261026013919 の版に4行足しただけ

alter table public.overtime_reports
  add column if not exists furikae_change_requested_at timestamptz,
  add column if not exists furikae_change_requested_by uuid,
  add column if not exists furikae_change_reason text,
  add column if not exists furikae_change_location text;
comment on column public.overtime_reports.furikae_change_requested_at is
  '振替休日の休む日を出勤に変える依頼（振替元の休日出勤は残す）を出した日時。受理で furikae_change_apply が振替休日を取り消して休日出勤を作る';
comment on column public.overtime_reports.furikae_change_location is
  '休む日の勤務地がいつもと違うとき（在宅など）。null＝いつもどおり（申請は作らない）';

create or replace function public.trg_furikae_report_state()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_is    boolean := new.entry_type = 'manual'
                     and 'furikae_off' = any (coalesce(new.application_types, '{}'))
                     and new.furikae_origin_date is not null;
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
begin
  -- 今ある行を移すとき（移行の SQL の中だけ立てる印）
  if coalesce(current_setting('app.furikae_migrate', true), '') = 'on' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.furikae_planned := null;
    new.furikae_not_worked_at := null;
    new.furikae_not_worked_reason := null;
    new.furikae_report_needed := v_is and public.furikae_report_switch_on() and new.furikae_origin_date >= v_today;
    -- 古い画面（端末の写し）が自己受理で「確認済み」を入れてきたときも、事前受理に直す
    if new.furikae_report_needed and new.status = 'confirmed' then
      new.status := 'request_confirmed';
      new.request_confirmed_at := coalesce(new.request_confirmed_at, new.confirmed_at, now());
      new.confirmed_by := null;
      new.confirmed_at := null;
    end if;
    return new;
  end if;

  -- UPDATE
  if not v_is then
    new.furikae_report_needed := false;
  elsif old.request_confirmed_at is null and new.request_confirmed_at is null
        and (new.furikae_origin_date is distinct from old.furikae_origin_date
             or (old.status = 'returned' and new.status = 'requested')) then
    -- まだ事前受理されていない申請の出し直し・振替元の日の変更だけ、計算し直す
    new.furikae_report_needed := public.furikae_report_switch_on() and new.furikae_origin_date >= v_today;
  else
    new.furikae_report_needed := old.furikae_report_needed;
  end if;

  -- 予定の控え：事前受理 → 実績報告／確定 の瞬間だけ写す。それ以外は変えさせない（本人は行を書き換えられるため）
  if old.furikae_report_needed and old.status = 'request_confirmed' and new.status in ('reported', 'confirmed') then
    new.furikae_planned := jsonb_build_object(
      'date', old.furikae_origin_date,
      'location', old.furikae_origin_location,
      'start', old.furikae_origin_start,
      'end', old.furikae_origin_end,
      'break_minutes', old.furikae_origin_break_minutes,
      'labor_minutes', old.furikae_origin_labor_minutes,
      'diff_minutes', old.diff_minutes);
  else
    new.furikae_planned := old.furikae_planned;
  end if;

  -- 勤務しなかった印は、サーバー（Edge Function）だけが付けられる（段5）
  if auth.uid() is not null then
    new.furikae_not_worked_at := old.furikae_not_worked_at;
    new.furikae_not_worked_reason := old.furikae_not_worked_reason;
    -- 振替休日の変更の依頼（休む日を出勤に・2026-10-26 段6）も、サーバーだけが付けられる
    new.furikae_change_requested_at := old.furikae_change_requested_at;
    new.furikae_change_requested_by := old.furikae_change_requested_by;
    new.furikae_change_reason := old.furikae_change_reason;
    new.furikae_change_location := old.furikae_change_location;
  end if;
  return new;
end;
$$;

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
  end if;

  return jsonb_build_object('holiday_id', v_hol, 'location_id', v_loc);
end;
$$;
revoke execute on function public.furikae_change_apply(uuid, uuid) from public;
revoke execute on function public.furikae_change_apply(uuid, uuid) from anon;
revoke execute on function public.furikae_change_apply(uuid, uuid) from authenticated;
grant execute on function public.furikae_change_apply(uuid, uuid) to service_role;
