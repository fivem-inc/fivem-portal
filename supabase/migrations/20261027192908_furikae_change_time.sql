-- 振替休日の［休む日を出勤に変える］で、休む日の時間も変えられるようにする（2026-10-27 ユーザー確定・計画 docs/計画-振替休日の変更-時間も.md）
-- ・本人は「時間や場所が違う」で、休む日の勤務時間（2本シフトの方は2つまで）・勤務地・遅出／早退の理由を入れる → 列 furikae_change_plan（入力だけ）
-- ・休憩・労働・差分・種別は、受理のとき furikae_change_eval がサーバーで計算する（画面は表示用に同じ計算をする。決まりは lib/breakCalc・lib/overtimeSubmit と同じ）
-- ・シフト調整：受理する人（自己受理は本人）が「必要」を選んだら、休む日の申請を shift_adjust_needed で作る（p_shift_needed）。今の「場所だけ」の経路も同じ
-- 🚨 furikae_change_apply・trg_furikae_report_state は本番の実定義（2026-10-27 に pg_get_functiondef で取得・20261026112435／20261026084104 と同じ）から起こした
-- 🚨 furikae_change_apply は引数を1つ足した（既定あり）。古い2引数の版は drop する（残すと PGRST203 で呼べなくなる）。順番は DB → Edge Function → 画面

alter table public.overtime_reports
  add column if not exists furikae_change_plan jsonb;
comment on column public.overtime_reports.furikae_change_plan is
  '振替休日の休む日を出勤に変える依頼で、時間や場所が違うときの入力（segments [{start,end}] 分・location・late_choice・early_choice）。null＝今までどおり（いつもどおり／場所だけ）。計算は受理のとき furikae_change_eval';

-- 1つの勤務の休憩（lib/breakCalc の calcSegmentBreak と同じ表）。🚨 片方だけ直さない
create or replace function public.ot_segment_break(p_start int, p_end int)
returns int
language sql
immutable
set search_path to 'public'
as $$
  select case
    when p_end - p_start <= 0 then 0
    when p_start < 13 * 60 then
      case when p_end - p_start < 4 * 60 + 15 then 0
           when p_end - p_start <= 6 * 60 + 30 then 30
           when p_end - p_start <= 8 * 60 + 45 then 45
           else 60 end
    else
      case when p_end - p_start <= 5 * 60 + 45 then 0
           when p_end - p_start <= 6 * 60 + 15 then 15
           when p_end - p_start <= 6 * 60 + 30 then 30
           when p_end - p_start <= 8 * 60 + 45 then 45
           else 60 end
  end
$$;
revoke execute on function public.ot_segment_break(int, int) from public;
revoke execute on function public.ot_segment_break(int, int) from anon;
revoke execute on function public.ot_segment_break(int, int) from authenticated;
grant execute on function public.ot_segment_break(int, int) to service_role;

-- 休む日の申請の中身を計算する（service だけ）。決まりは画面の lib/furikaeReport の furikaeChangeEval と同じ
-- 戻り値 {segs [[start,end],…], break_minutes, labor_minutes, diff_minutes, types[], late_situation, early_situation, location, legal_warning}
create or replace function public.furikae_change_eval(p_normal jsonb, p_plan jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_ns1 int; v_ne1 int; v_ns2 int; v_ne2 int;
  v_nstart int; v_nend int; v_nlabor int;
  v_nloc text := nullif(trim(coalesce(p_normal->>'location', '')), '');
  v_loc  text := nullif(trim(coalesce(p_plan->>'location', '')), '');
  v_late text := nullif(p_plan->>'late_choice', '');
  v_early text := nullif(p_plan->>'early_choice', '');
  v_segs int[][] := '{}';
  v_s int; v_e int; v_n int; i int;
  v_span int := 0; v_break int := 0; v_gap int := 0; v_labor int; v_req int;
  v_bs int; v_be int;
  v_types text[] := '{}';
  v_same boolean;
  e jsonb;
begin
  -- 通常シフト
  if nullif(p_normal->>'start_time', '') is null or nullif(p_normal->>'end_time', '') is null then
    raise exception 'FURIKAE_CHANGE|この日の通常シフトが無いため、時間を変えられません';
  end if;
  v_ns1 := split_part(p_normal->>'start_time', ':', 1)::int * 60 + split_part(p_normal->>'start_time', ':', 2)::int;
  v_ne1 := split_part(p_normal->>'end_time', ':', 1)::int * 60 + split_part(p_normal->>'end_time', ':', 2)::int;
  if nullif(p_normal->>'start_time2', '') is not null and nullif(p_normal->>'end_time2', '') is not null then
    v_ns2 := split_part(p_normal->>'start_time2', ':', 1)::int * 60 + split_part(p_normal->>'start_time2', ':', 2)::int;
    v_ne2 := split_part(p_normal->>'end_time2', ':', 1)::int * 60 + split_part(p_normal->>'end_time2', ':', 2)::int;
  end if;
  v_nstart := least(v_ns1, coalesce(v_ns2, v_ns1));
  v_nend := greatest(v_ne1, coalesce(v_ne2, v_ne1));
  v_nlabor := coalesce((p_normal->>'labor_minutes')::int, 0);

  -- 入力の時間（1〜2つ・並べ替える・重なり不可）
  if jsonb_typeof(p_plan->'segments') <> 'array' then raise exception 'FURIKAE_CHANGE|勤務時間を入力してください'; end if;
  v_n := jsonb_array_length(p_plan->'segments');
  if v_n < 1 or v_n > 2 then raise exception 'FURIKAE_CHANGE|勤務時間を入力してください'; end if;
  for e in select x from jsonb_array_elements(p_plan->'segments') x order by (x->>'start')::int loop
    v_s := (e->>'start')::int; v_e := (e->>'end')::int;
    if v_s is null or v_e is null or v_s < 0 or v_e > 1440 or v_e <= v_s then
      raise exception 'FURIKAE_CHANGE|勤務時間の入力を確認してください';
    end if;
    if array_length(v_segs, 1) is not null and v_s < v_segs[array_length(v_segs, 1)][2] then
      raise exception 'FURIKAE_CHANGE|勤務の時間が重なっています。開始・終了時刻を確認してください';
    end if;
    v_segs := v_segs || array[[v_s, v_e]];
  end loop;

  -- 休憩（つながった時間帯は1つの勤務として数える＝lib/breakCalc の calcTotalBreak）・労働・差分
  v_bs := v_segs[1][1]; v_be := v_segs[1][2];
  for i in 1 .. array_length(v_segs, 1) loop
    v_span := v_span + (v_segs[i][2] - v_segs[i][1]);
    if i > 1 then
      if v_segs[i][1] = v_be then
        v_be := v_segs[i][2];
      else
        v_break := v_break + public.ot_segment_break(v_bs, v_be);
        v_gap := v_gap + (v_segs[i][1] - v_be);
        v_bs := v_segs[i][1]; v_be := v_segs[i][2];
      end if;
    end if;
  end loop;
  v_break := v_break + public.ot_segment_break(v_bs, v_be);
  v_labor := v_span - v_break;
  v_req := case when v_labor > 480 then 60 when v_labor > 360 then 45 else 0 end;

  -- 勤務地（空ならいつもの校）
  v_loc := coalesce(v_loc, v_nloc);
  if v_loc is null then raise exception 'FURIKAE_CHANGE|勤務地を選んでください'; end if;

  -- 種別（lib/overtimeSubmit の detectOvertimeTypes・composeApplicationTypes と同じ順）
  if v_segs[array_length(v_segs, 1)][2] > v_nend then v_types := array_append(v_types, 'overtime'); end if;
  if v_segs[1][1] < v_nstart then v_types := array_append(v_types, 'early_start'); end if;
  if strpos(v_loc, '→') > 0 or (v_nloc is not null and v_loc <> v_nloc) then v_types := array_append(v_types, 'location_change'); end if;
  if v_segs[1][1] > v_nstart then
    if v_late is null or v_late not in ('adj', 'short_term', 'match', 'event', 'telework', 'tardiness') then
      raise exception 'FURIKAE_CHANGE|「開始が遅い理由」を選んでください';
    end if;
    v_types := array_append(v_types, case when v_late = 'tardiness' then 'tardiness' else 'late_start_adj' end);
  end if;
  if v_segs[array_length(v_segs, 1)][2] < v_nend then
    if v_early is null or v_early not in ('adj', 'short_term', 'match', 'event', 'telework', 'early_leave') then
      raise exception 'FURIKAE_CHANGE|「早く終わる理由」を選んでください';
    end if;
    v_types := array_append(v_types, case when v_early = 'early_leave' then 'early_leave' else 'early_end_adj' end);
  end if;

  if cardinality(v_types) = 0 then
    v_same := v_segs = case when v_ns2 is null then array[[v_ns1, v_ne1]] else array[[least(v_ns1, v_ns2), case when v_ns1 <= v_ns2 then v_ne1 else v_ne2 end],
                                                                                  [greatest(v_ns1, v_ns2), case when v_ns1 <= v_ns2 then v_ne2 else v_ne1 end]] end;
    if v_same then raise exception 'FURIKAE_CHANGE|通常シフトと同じです。［いつもどおり］を選んでください'; end if;
    raise exception 'FURIKAE_CHANGE|始まりと終わりが通常シフトと同じため、種別が決まりません。始まりか終わりの時刻を変えてください';
  end if;

  return jsonb_build_object(
    'segs', to_jsonb(v_segs),
    'break_minutes', v_break,
    'labor_minutes', v_labor,
    'diff_minutes', v_labor - v_nlabor,
    'types', to_jsonb(v_types),
    'late_situation', case when 'late_start_adj' = any (v_types) then v_late end,
    'early_situation', case when 'early_end_adj' = any (v_types) then v_early end,
    'location', v_loc,
    'legal_warning', (v_break + v_gap) < v_req);
end;
$$;
revoke execute on function public.furikae_change_eval(jsonb, jsonb) from public;
revoke execute on function public.furikae_change_eval(jsonb, jsonb) from anon;
revoke execute on function public.furikae_change_eval(jsonb, jsonb) from authenticated;
grant execute on function public.furikae_change_eval(jsonb, jsonb) to service_role;

-- 印の見張り（本番の実定義に1行足しただけ：furikae_change_plan も本人に書き換えさせない）
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
    new.furikae_change_plan := old.furikae_change_plan;
    -- 🚨 依頼中は、休む日の通常シフト（計算の元）も本人に書き換えさせない（2026-10-27）
    if old.furikae_change_requested_at is not null then
      new.normal_shift := old.normal_shift;
    end if;
  end if;
  return new;
end;
$$;

-- 変更を当てる（service だけ）。戻り値 {holiday_id, location_id}（キーの名前は Edge Function が読むので変えない）
-- p_shift_needed：休む日の申請（遅出・早退・勤務地変更）をシフト調整「必要」で作る（受理する人が選んだとき・2026-10-27）
drop function if exists public.furikae_change_apply(uuid, uuid);
create or replace function public.furikae_change_apply(p_id uuid, p_actor uuid, p_shift_needed boolean default false)
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
  v_ev     jsonb;
  v_past   boolean;
  v_types  text[];
  seg      jsonb;
  k        int := 0;
begin
  select * into r from overtime_reports where id = p_id for update;
  if not found then raise exception 'FURIKAE_CHANGE|対象の申請が見つかりません'; end if;
  if r.entry_type <> 'manual' or not ('furikae_off' = any (coalesce(r.application_types, '{}'))) or r.furikae_origin_date is null then
    raise exception 'FURIKAE_CHANGE|振替休日の申請ではありません';
  end if;
  if r.furikae_change_requested_at is null then raise exception 'FURIKAE_CHANGE|変更の依頼がありません'; end if;
  if r.status not in ('requested', 'request_confirmed', 'reported', 'confirmed') then raise exception 'FURIKAE_CHANGE|この状態では変えられません'; end if;
  if r.furikae_origin_start is null or r.furikae_origin_end is null then raise exception 'FURIKAE_CHANGE|振替元の時刻がありません'; end if;

  v_past := r.work_date < v_today;
  -- 休む日の申請の中身を先に決める（計算できなければ、何も変えずに止める）
  if r.furikae_change_plan is not null then
    v_ev := public.furikae_change_eval(r.normal_shift, r.furikae_change_plan);
    v_types := array(select jsonb_array_elements_text(v_ev->'types'));
  elsif nullif(trim(coalesce(r.furikae_change_location, '')), '') is not null then
    if nullif(r.normal_shift->>'start_time', '') is null or nullif(r.normal_shift->>'end_time', '') is null then
      raise exception 'FURIKAE_CHANGE|この日の通常シフトが無いため、勤務地を変えられません';
    end if;
    v_types := array['location_change'];
  end if;
  -- シフト調整「必要」は、遅出・早退・勤務地変更を含む今日以降の申請だけ（DB の見張り enforce_overtime_shift_needed と同じ）
  if p_shift_needed and (v_types is null or v_past
                         or not (v_types && array['location_change', 'late_start_adj', 'tardiness', 'early_end_adj', 'early_leave'])) then
    raise exception 'FURIKAE_CHANGE|この変更では、シフト調整を選べません（遅出・早退・勤務地変更を含む、今日以降の変更だけです）';
  end if;

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

  if v_ev is not null then
    -- ③ 休む日の時間や場所が違う（2026-10-27）：計算した中身で1件
    insert into overtime_reports (applicant_id, submitted_by, reviewer_id, work_date, pay_period_start, entry_type, is_post_hoc, status,
      normal_shift, break_minutes, break_manual, labor_minutes, diff_minutes, legal_warning, reason, change_reason, location, application_types,
      late_situation, early_situation, request_confirmed_at, confirmed_by, confirmed_at, shift_adjust_needed, shift_adjusted_by, shift_adjusted_at)
    values (r.applicant_id, r.applicant_id, r.reviewer_id, r.work_date, public.calc_pay_period_start(r.work_date), 'manual',
      v_past, case when v_past then 'confirmed' else 'request_confirmed' end,
      r.normal_shift, (v_ev->>'break_minutes')::int, false, (v_ev->>'labor_minutes')::int, (v_ev->>'diff_minutes')::int, (v_ev->>'legal_warning')::boolean,
      '振替休日から変更（休む日を出勤に・' || coalesce(r.furikae_change_reason, '') || '）', null, v_ev->>'location', v_types,
      v_ev->>'late_situation', v_ev->>'early_situation',
      now(), case when v_past then p_actor end, case when v_past then now() end,
      p_shift_needed, case when p_shift_needed then p_actor end, case when p_shift_needed then now() end)
    returning id into v_loc;
    for seg in select x from jsonb_array_elements(v_ev->'segs') x loop
      k := k + 1;
      insert into overtime_report_segments (report_id, phase, seg_no, start_min, end_min) values (v_loc, 'planned', k, (seg->>0)::int, (seg->>1)::int);
    end loop;
    if v_past then
      insert into overtime_report_segments (report_id, phase, seg_no, start_min, end_min)
        select v_loc, 'actual', seg_no, start_min, end_min from overtime_report_segments where report_id = v_loc and phase = 'planned';
    end if;
    insert into overtime_report_history (report_id, changed_by, change_kind, change_summary, snapshot)
    select v_loc, p_actor, 'edited', '振替休日（元の申請 ' || r.id || '）の変更で作成：休む日の勤務（時間・場所の変更）', to_jsonb(x) from overtime_reports x where x.id = v_loc;
  elsif v_types is not null then
    -- ③ 休む日がいつもと違う場所なら勤務地変更（時間は休む日の通常シフトのまま）
    insert into overtime_reports (applicant_id, submitted_by, reviewer_id, work_date, pay_period_start, entry_type, is_post_hoc, status,
      normal_shift, break_minutes, break_manual, labor_minutes, diff_minutes, legal_warning, reason, change_reason, location, application_types,
      request_confirmed_at, confirmed_by, confirmed_at, shift_adjust_needed, shift_adjusted_by, shift_adjusted_at)
    values (r.applicant_id, r.applicant_id, r.reviewer_id, r.work_date, public.calc_pay_period_start(r.work_date), 'manual',
      v_past, case when v_past then 'confirmed' else 'request_confirmed' end,
      r.normal_shift, coalesce((r.normal_shift->>'break_minutes')::int, 0), false, coalesce((r.normal_shift->>'labor_minutes')::int, 0), 0, false,
      '振替休日から変更（休む日を出勤に・' || coalesce(r.furikae_change_reason, '') || '）', null, trim(r.furikae_change_location), array['location_change'],
      now(), case when v_past then p_actor end, case when v_past then now() end,
      p_shift_needed, case when p_shift_needed then p_actor end, case when p_shift_needed then now() end)
    returning id into v_loc;
    v_s := split_part(r.normal_shift->>'start_time', ':', 1)::int * 60 + split_part(r.normal_shift->>'start_time', ':', 2)::int;
    v_e := split_part(r.normal_shift->>'end_time', ':', 1)::int * 60 + split_part(r.normal_shift->>'end_time', ':', 2)::int;
    insert into overtime_report_segments (report_id, phase, seg_no, start_min, end_min) values (v_loc, 'planned', 1, v_s, v_e);
    if nullif(r.normal_shift->>'start_time2', '') is not null and nullif(r.normal_shift->>'end_time2', '') is not null then
      v_s2 := split_part(r.normal_shift->>'start_time2', ':', 1)::int * 60 + split_part(r.normal_shift->>'start_time2', ':', 2)::int;
      v_e2 := split_part(r.normal_shift->>'end_time2', ':', 1)::int * 60 + split_part(r.normal_shift->>'end_time2', ':', 2)::int;
      insert into overtime_report_segments (report_id, phase, seg_no, start_min, end_min) values (v_loc, 'planned', 2, v_s2, v_e2);
    end if;
    if v_past then
      insert into overtime_report_segments (report_id, phase, seg_no, start_min, end_min)
        select v_loc, 'actual', seg_no, start_min, end_min from overtime_report_segments where report_id = v_loc and phase = 'planned';
    end if;
    insert into overtime_report_history (report_id, changed_by, change_kind, change_summary, snapshot)
    select v_loc, p_actor, 'edited', '振替休日（元の申請 ' || r.id || '）の変更で作成：休む日の勤務地変更', to_jsonb(x) from overtime_reports x where x.id = v_loc;
  end if;

  return jsonb_build_object('holiday_id', v_hol, 'location_id', v_loc);
end;
$$;
revoke execute on function public.furikae_change_apply(uuid, uuid, boolean) from public;
revoke execute on function public.furikae_change_apply(uuid, uuid, boolean) from anon;
revoke execute on function public.furikae_change_apply(uuid, uuid, boolean) from authenticated;
grant execute on function public.furikae_change_apply(uuid, uuid, boolean) to service_role;
