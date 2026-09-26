-- ============================================================
-- 2026-09-26  勤怠カレンダー：振替休日の「振替元（休日出勤した日）」も出す
-- ============================================================
-- ユーザー指摘（2026-09-26）：長岡さん 10/26 振替休日（振替元 10/25 日・上桂校・09:30〜18:00・大掃除）。
--   10/26 の「振休」は載るのに、**10/25 の休日出勤がカレンダーに無かった**。申請には振替元の日付・校・時間が入っている。
--   1回の申請で両方載せる（Google カレンダー側は gcal-sync で同日に対応）。
--
-- 直し方：calendar_overtime_events に振替元の行を union all で足す。
--   ・work_date＝振替元の日、application_types＝['holiday_work']、location＝振替元の校、時間＝振替元の出退勤
--   ・is_post_hoc は false で返す（画面の willShowOnCalendar は「事後の休日出勤」を隠すが、振替元は実際に出た日で、
--     終日種別（振休）と同じく事後でも出すべきもの）
--   ・新しい列 origin_of＝元の申請の id（画面で「休日出勤(振替元)」と出すため。ふつうの行は null）
-- 🚨 戻り値の列が増えるので drop → create（create or replace では列を変えられない）。権限も付け直す。
-- 🚨 本番の実定義（pg_get_functiondef・2026-09-26）から起こした。元の select は1文字も変えていない（末尾に union all を足しただけ）。
-- 🚨 reason は返さない方針のまま（他の人に理由が見えないように）。

drop function if exists public.calendar_overtime_events(date, date);

create function public.calendar_overtime_events(p_from date, p_to date)
returns table (
  id uuid, applicant_id uuid, name text, work_date date, application_types text[], is_post_hoc boolean,
  show_on_calendar boolean, location text, start_min integer, end_min integer, status text,
  origin_of uuid
)
language sql
stable security definer
set search_path to 'public'
as $$
  select
    r.id,
    r.applicant_id,
    p.name,
    r.work_date,
    r.application_types,
    r.is_post_hoc,
    r.show_on_calendar,
    r.location,
    s.start_min,
    s.end_min,
    -- 画面で「申請中」バッジを出すために使う。理由(reason)は返さない方針は変えない
    r.status,
    null::uuid as origin_of
  from overtime_reports r
  join profiles p on p.id = r.applicant_id
  left join lateral (
    -- 実績があれば実績、なければ予定の時間帯（gcal-sync のタイトル生成と同じ考え方）
    select min(g.start_min)::int as start_min,
           max(g.end_min)::int   as end_min
    from overtime_report_segments g
    where g.report_id = r.id
      and g.phase = case
        when exists (
          select 1 from overtime_report_segments a
          where a.report_id = r.id and a.phase = 'actual'
        ) then 'actual' else 'planned'
      end
  ) s on true
  where has_feature_permission('leave_calendar')
    and r.work_date between p_from and p_to
    and r.entry_type = 'manual'
    -- 申請済みのもの（gcal-sync の同期条件と同じ）。
    -- 'requested'（申請中）を含めるのが今回の変更。差し戻し・取消はここで落ちる
    and r.status in ('requested', 'request_confirmed', 'reported', 'confirmed')
    -- 本人が「載せない」と決めたものは返さない（null＝未指定はここでは落とさない）
    and r.show_on_calendar is distinct from false
    and coalesce(array_length(r.application_types, 1), 0) > 0

  union all

  -- 振替休日の振替元（休日出勤した日）。2026-09-26
  select
    r.id,
    r.applicant_id,
    p.name,
    r.furikae_origin_date as work_date,
    array['holiday_work']::text[] as application_types,
    false as is_post_hoc,
    r.show_on_calendar,
    r.furikae_origin_location as location,
    (extract(hour from r.furikae_origin_start) * 60 + extract(minute from r.furikae_origin_start))::int as start_min,
    (extract(hour from r.furikae_origin_end)   * 60 + extract(minute from r.furikae_origin_end))::int   as end_min,
    r.status,
    r.id as origin_of
  from overtime_reports r
  join profiles p on p.id = r.applicant_id
  where has_feature_permission('leave_calendar')
    and r.furikae_origin_date is not null
    and r.furikae_origin_date between p_from and p_to
    and r.entry_type = 'manual'
    and r.status in ('requested', 'request_confirmed', 'reported', 'confirmed')
    and r.show_on_calendar is distinct from false
    and 'furikae_off' = any(r.application_types);
$$;

comment on function public.calendar_overtime_events(date, date) is
  '勤怠カレンダー用。期間内の残業・時間の申請（申請済み・載せない以外）と、振替休日の振替元の日（origin_of＝元の申請）を返す。理由は返さない';

-- 🚨 Supabase は新しい関数に anon の実行権限を自動で付ける。from public だけでは外れない
revoke execute on function public.calendar_overtime_events(date, date) from public;
revoke execute on function public.calendar_overtime_events(date, date) from anon;
grant  execute on function public.calendar_overtime_events(date, date) to authenticated;

-- 確認用:
--   select has_function_privilege('anon', 'public.calendar_overtime_events(date,date)', 'execute');  -- false
--   （リーダー以上になりすまして）select work_date, application_types, location, start_min, end_min, origin_of
--     from calendar_overtime_events('2026-10-25', '2026-10-26');   -- 10/25 の holiday_work（上桂校・570〜1080）と 10/26 の furikae_off
