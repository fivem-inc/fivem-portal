-- 打刻の確認：段階1（2026-10-13・計画は docs/計画-打刻の確認の改善.md の 6〜8 章・ユーザー確定）
--
-- 申請がある日にも打刻の確認を送れるようにし、本人の答えを「その日の申請の状態」で分ける。
--   申請なし／休暇の日 … worked（業務をしていました）／not_worked（定時でした・打刻が遅れただけ）／unknown
--   報告済み・受理済み … as_reported（申請の通りです）／time_differs（時刻が違います＋正しい勤務時間）／unknown
--   事前申請だけ       … as_reported（予定どおり勤務しました）／time_differs／unknown
--   差し戻し中         … will_resubmit（申請を直して出し直します）／unknown
--   終日・振替元の日   … as_reported（申請の通りです）／unknown
-- 🚨 状態は「本人が答える時点」でサーバーが決める（送ったあとに申請を出した・取り消した場合に合わせる）。
--    判定は clock_inquiry_day_state 1か所（画面の読み込み clock_inquiry_day_states と答えの受け取りで共用）。
-- 🚨 answer_overtime_clock_inquiry は本番の実定義（2026-10-13 取得）から起こし、日ごとの更新だけを置き換えた。
--    open→answered を1回だけ成立させる・未回答が残れば例外で全体を戻す・経理へのベル、は元のまま。
-- 段階2 で使う列（resolved_*）も先に足しておく（経理が直した／取り消した／このまま）。

begin;

-- ========================================
-- 1) 列
-- ========================================
alter table public.overtime_clock_inquiry_days
  add column if not exists existing_report_id uuid references public.overtime_reports(id) on delete set null,
  add column if not exists report_state text,
  add column if not exists answer_segments jsonb,
  add column if not exists resolved_kind text,
  add column if not exists resolved_at timestamptz,
  add column if not exists resolved_by uuid references public.profiles(id) on delete set null;

alter table public.overtime_clock_inquiry_days drop constraint if exists overtime_clock_inquiry_days_answer_check;
alter table public.overtime_clock_inquiry_days add constraint overtime_clock_inquiry_days_answer_check
  check (answer in ('pending', 'worked', 'not_worked', 'unknown', 'as_reported', 'time_differs', 'will_resubmit'));
alter table public.overtime_clock_inquiry_days drop constraint if exists overtime_clock_inquiry_days_report_state_check;
alter table public.overtime_clock_inquiry_days add constraint overtime_clock_inquiry_days_report_state_check
  check (report_state is null or report_state in ('none', 'leave', 'reported', 'planned', 'returned', 'fullday'));
alter table public.overtime_clock_inquiry_days drop constraint if exists overtime_clock_inquiry_days_resolved_kind_check;
alter table public.overtime_clock_inquiry_days add constraint overtime_clock_inquiry_days_resolved_kind_check
  check (resolved_kind is null or resolved_kind in ('edited', 'cancelled', 'kept'));

comment on column public.overtime_clock_inquiry_days.existing_report_id is '本人が答えた時点で、その日に出ていた手動の申請（2026-10-13）';
comment on column public.overtime_clock_inquiry_days.report_state is '本人が答えた時点のその日の申請の状態 none/leave/reported/planned/returned/fullday（2026-10-13）';
comment on column public.overtime_clock_inquiry_days.answer_segments is '「時刻が違います」で本人が入れた正しい勤務時間 [{start_min,end_min}]（2026-10-13）';

-- ========================================
-- 2) その日の申請の状態（判定は1か所）
-- ========================================
create or replace function public.clock_inquiry_day_state(p_user uuid, p_date date)
returns table (
  state text, report_id uuid, status text, application_types text[], is_post_hoc boolean,
  diff_minutes integer, normal_shift jsonb, segments jsonb, furikae_origin boolean
)
language plpgsql stable security definer set search_path to 'public'
as $$
declare
  r public.overtime_reports%rowtype;
  v_d text := to_char(p_date, 'YYYY-MM-DD');
begin
  select o.* into r from overtime_reports o
   where o.applicant_id = p_user and o.work_date = p_date
     and o.entry_type = 'manual' and o.status <> 'cancelled'
   limit 1;
  if found then
    state := case
      when r.status = 'returned' then 'returned'
      when coalesce(r.application_types, '{}') && array['chosei_off', 'furikae_off', 'absence'] then 'fullday'
      when r.status in ('requested', 'request_confirmed') then 'planned'
      else 'reported' end;
    report_id := r.id; status := r.status; application_types := r.application_types;
    is_post_hoc := r.is_post_hoc; diff_minutes := r.diff_minutes; normal_shift := r.normal_shift;
    furikae_origin := false;
    segments := (
      select jsonb_agg(jsonb_build_object('start_min', s.start_min, 'end_min', s.end_min) order by s.start_min)
        from overtime_report_segments s
       where s.report_id = r.id
         and s.phase = case when exists (select 1 from overtime_report_segments x where x.report_id = r.id and x.phase = 'actual')
                            then 'actual' else 'planned' end);
    return next;
    return;
  end if;

  -- 振替休日の振替元の日（その日には申請の行が無いが、申請済みとして扱う）
  select o.* into r from overtime_reports o
   where o.applicant_id = p_user and o.furikae_origin_date = p_date
     and o.entry_type = 'manual' and o.status <> 'cancelled'
   limit 1;
  if found then
    state := 'fullday'; report_id := r.id; status := r.status; application_types := r.application_types;
    is_post_hoc := r.is_post_hoc; diff_minutes := r.diff_minutes; normal_shift := r.normal_shift;
    furikae_origin := true; segments := null;
    return next;
    return;
  end if;

  if exists (select 1 from leave_requests l
              where l.user_id = p_user and coalesce(l.status, '') not in ('rejected', 'cancelled')
                and (case when l.leave_dates like '[%' then (l.leave_dates::jsonb ? v_d)
                          else p_date between l.start_date and l.end_date end))
     or exists (select 1 from overtime_reports o
                 where o.applicant_id = p_user and o.work_date = p_date
                   and o.entry_type = 'leave_auto' and o.status <> 'cancelled') then
    state := 'leave';
  else
    state := 'none';
  end if;
  report_id := null; status := null; application_types := null; is_post_hoc := null;
  diff_minutes := null; normal_shift := null; segments := null; furikae_origin := false;
  return next;
end;
$$;
revoke execute on function public.clock_inquiry_day_state(uuid, date) from public;
revoke execute on function public.clock_inquiry_day_state(uuid, date) from anon;
revoke execute on function public.clock_inquiry_day_state(uuid, date) from authenticated;

-- 画面用：本人か管理者（経理）が、ある人の複数の日の状態をまとめて読む
create or replace function public.clock_inquiry_day_states(p_user uuid, p_dates date[])
returns table (
  work_date date, state text, report_id uuid, status text, application_types text[], is_post_hoc boolean,
  diff_minutes integer, normal_shift jsonb, segments jsonb, furikae_origin boolean
)
language plpgsql stable security definer set search_path to 'public'
as $$
begin
  if auth.uid() is null or (auth.uid() <> p_user and not is_admin()) then
    raise exception 'CLOCK_INQ_FORBIDDEN: 権限がありません' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(array_length(p_dates, 1), 0) > 62 then
    raise exception 'CLOCK_INQ_TOO_MANY: 一度に読める日は62日までです' using errcode = 'check_violation';
  end if;
  return query
    select d, s.state, s.report_id, s.status, s.application_types, s.is_post_hoc,
           s.diff_minutes, s.normal_shift, s.segments, s.furikae_origin
      from unnest(coalesce(p_dates, '{}'::date[])) as d
      cross join lateral clock_inquiry_day_state(p_user, d) as s;
end;
$$;
revoke execute on function public.clock_inquiry_day_states(uuid, date[]) from public;
revoke execute on function public.clock_inquiry_day_states(uuid, date[]) from anon;
grant execute on function public.clock_inquiry_day_states(uuid, date[]) to authenticated;

-- ========================================
-- 3) 答えを受け取る（本番の実定義から。日ごとの更新だけ置き換え）
-- ========================================
create or replace function public.answer_overtime_clock_inquiry(p_inquiry_id uuid, p_days jsonb, p_note text default null::text)
returns boolean
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_claimed  int;
  v_sender   uuid;
  v_user     uuid;
  v_name     text;
  v_worked   int;
  v_not      int;
  v_unknown  int;
  v_asrep    int;
  v_differs  int;
  v_resub    int;
  v_summary  text;
  v_site_on  boolean;
  v_day      record;
  v_e        jsonb;
  v_ans      text;
  v_st       record;
  v_segs     jsonb;
  v_seg      jsonb;
  v_prev_end int;
  v_s        int;
  v_t        int;
  v_note     text;
  v_link     uuid;
  v_label    text;
begin
  update public.overtime_clock_inquiries
     set status = 'answered', answered_at = now()
   where id = p_inquiry_id and user_id = auth.uid() and status = 'open'
  returning sender_id, user_id into v_sender, v_user;

  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    return false;  -- 既に回答済み or 権限なし → 呼び出し側で案内を出す
  end if;

  -- 日ごとに、答える時点の申請の状態を見て、選べる答えかを確かめてから書く（2026-10-13）
  for v_day in
    select d.id, d.work_date from public.overtime_clock_inquiry_days d where d.inquiry_id = p_inquiry_id
  loop
    v_e := null;  -- 🚨 見つからないと前の日の値が残るので、毎回空にする
    select e into v_e from jsonb_array_elements(coalesce(p_days, '[]'::jsonb)) e
     where (e ->> 'day_id')::uuid = v_day.id limit 1;
    if v_e is null then continue; end if;  -- 未回答のまま → 下の pending の確かめで止まる
    v_ans := nullif(v_e ->> 'answer', '');
    if v_ans is null or v_ans = 'pending' then continue; end if;

    select * into v_st from public.clock_inquiry_day_state(v_user, v_day.work_date);
    v_label := to_char(v_day.work_date, 'FMMM/FMDD');

    if not (
      (v_st.state in ('none', 'leave') and v_ans in ('worked', 'not_worked', 'unknown'))
      or (v_st.state in ('reported', 'planned') and v_ans in ('as_reported', 'time_differs', 'unknown'))
      or (v_st.state = 'returned' and v_ans in ('will_resubmit', 'unknown'))
      or (v_st.state = 'fullday' and v_ans in ('as_reported', 'unknown'))
    ) then
      raise exception 'CLOCK_INQ_STATE_CHANGED: % の申請の状態が変わっています。画面を読み込み直してから答えてください', v_label
        using errcode = 'P0001';
    end if;

    v_note := nullif(btrim(coalesce(v_e ->> 'note', '')), '');
    v_segs := null;
    if v_ans = 'time_differs' then
      if v_note is null then
        raise exception 'CLOCK_INQ_NOTE_REQUIRED: % のひとことを書いてください', v_label using errcode = 'P0001';
      end if;
      v_segs := v_e -> 'segments';
      if v_segs is null or jsonb_typeof(v_segs) <> 'array'
         or jsonb_array_length(v_segs) < 1 or jsonb_array_length(v_segs) > 3 then
        raise exception 'CLOCK_INQ_BAD_SEGMENTS: % の勤務時間を入れてください', v_label using errcode = 'P0001';
      end if;
      v_prev_end := -1;
      for v_seg in select x from jsonb_array_elements(v_segs) x loop
        v_s := (v_seg ->> 'start_min')::int;
        v_t := (v_seg ->> 'end_min')::int;
        if v_s is null or v_t is null or v_s < 0 or v_t <= v_s or v_t > 2880 or v_s < v_prev_end then
          raise exception 'CLOCK_INQ_BAD_SEGMENTS: % の勤務時間が正しくありません', v_label using errcode = 'P0001';
        end if;
        v_prev_end := v_t;
      end loop;
    end if;

    -- 申請がある日の答えは、その申請と確認を結び付ける（新しい記録は作らない）
    v_link := case when v_st.report_id is not null and v_ans in ('as_reported', 'time_differs', 'will_resubmit')
                   then v_st.report_id else null end;

    update public.overtime_clock_inquiry_days d set
      answer             = v_ans,
      answer_reason      = nullif(v_e ->> 'reason', ''),
      answer_note        = v_note,
      answer_segments    = v_segs,
      existing_report_id = v_st.report_id,
      report_state       = v_st.state,
      result_report_id   = coalesce(v_link, d.result_report_id)
    where d.id = v_day.id;

    if v_link is not null then
      update public.overtime_submission_grants
         set revoked_at = now()
       where user_id = v_user and work_date = v_day.work_date
         and source = 'clock_inquiry' and revoked_at is null;
    end if;
  end loop;

  -- 反映漏れ・空配列で「回答済みなのに全部 未回答」を作らない。
  -- この RPC は open のときだけ成立する＝やり直しがきかないので、ここで止める。
  -- 例外なら上の status 更新ごとロールバックされ、open のまま再試行できる。
  if exists (
    select 1 from public.overtime_clock_inquiry_days
     where inquiry_id = p_inquiry_id and answer = 'pending'
  ) then
    raise exception 'まだ回答していない日があります' using errcode = 'P0001';
  end if;

  select count(*) filter (where answer = 'worked'),
         count(*) filter (where answer = 'not_worked'),
         count(*) filter (where answer = 'unknown'),
         count(*) filter (where answer = 'as_reported'),
         count(*) filter (where answer = 'time_differs'),
         count(*) filter (where answer = 'will_resubmit')
    into v_worked, v_not, v_unknown, v_asrep, v_differs, v_resub
    from public.overtime_clock_inquiry_days where inquiry_id = p_inquiry_id;

  select name into v_name from public.profiles where id = auth.uid();

  v_summary := concat_ws('／',
    case when v_differs > 0 then '時刻が違う '       || v_differs || '日' end,
    case when v_resub   > 0 then '申請を出し直す '   || v_resub   || '日' end,
    case when v_asrep   > 0 then '申請の通り '       || v_asrep   || '日' end,
    case when v_not     > 0 then '定時（打刻が遅れただけ） ' || v_not || '日' end,
    case when v_worked  > 0 then '業務をしていた '   || v_worked  || '日' end,
    case when v_unknown > 0 then '思い出せない '     || v_unknown || '日' end
  );
  if nullif(btrim(coalesce(p_note, '')), '') is not null then
    v_summary := v_summary || '　' || btrim(p_note);
  end if;

  select enabled into v_site_on from public.notification_settings
   where event_key = 'overtime:clock_inquiry_answered' and channel = 'site';

  if coalesce(v_site_on, true) then
    insert into public.notifications
      (user_id, message, sub_message, source_type, reference_id, event_key)
    values (
      v_sender,
      coalesce(v_name, 'スタッフ') || 'さんが勤務時間の確認に回答しました',
      v_summary,
      'overtime:clock_inquiry_answered', p_inquiry_id::text, 'overtime:clock_inquiry_answered'
    );
  end if;

  return true;
end; $function$;
revoke execute on function public.answer_overtime_clock_inquiry(uuid, jsonb, text) from public;
revoke execute on function public.answer_overtime_clock_inquiry(uuid, jsonb, text) from anon;
grant execute on function public.answer_overtime_clock_inquiry(uuid, jsonb, text) to authenticated;

-- ========================================
-- 4) 社内FAQ（打刻の確認の答え方）を新しい答えに合わせる
-- ========================================
update public.faq_answers
   set body = E'通常シフトと打刻がずれている日について、経理から「実際どうでしたか？」と確認が届くものです。\n\n'
           || E'通知をタップすると回答画面（残業ページ内）が開き、日ごとに回答します。答えは、その日に申請を出しているかどうかで変わります。\n\n'
           || E'■ 申請を出していない日\n'
           || E'・「業務をしていました」→ 回答の確定後にそのまま残業報告へ進めます\n'
           || E'・「定時でした（打刻が遅れただけ）」→ 打刻ズレの記録が自動で作られます\n'
           || E'・「思い出せない・その他」→ 経理に相談します\n\n'
           || E'■ 申請を出している日\n'
           || E'・「申請の通りです」→ 新しい記録は作りません\n'
           || E'・「時刻が違います」→ 実際の勤務時間（出勤〜退勤）とひとことを入れます。経理が確認して申請を直します\n'
           || E'・事前申請だけの日は「予定どおり勤務しました」→ 回答のあと、実績を報告します\n'
           || E'・差し戻し中の日は「申請を直して出し直します」→ 回答のあと、申請を直して出し直します'
 where id = '0cb293b1-ebf0-47cc-af3a-dd78ac2186e3'
   and body like '%業務は終わっていました%';

commit;
