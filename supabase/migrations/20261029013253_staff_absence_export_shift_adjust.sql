-- 2026-10-29 staff_absence_export：シフト調整で正社員の方が代わりに決まった日を、残業申請を出す前から出す（ユーザー確定 ③-ア）
-- ・前は、ご本人が残業申請（勤務地変更など）を出すまで CSV に出ず、班分けのツールではふだんの校にいる扱いだった
-- ・種類：その日に登録シフトが無ければ「休日出勤」・あれば「時間変更」。時間＝代わりの時間帯と校。状態＝受理待ち・どこから＝シフト調整
-- 本番の実定義＝20261028234411 と同じことを確かめてから直した。権限は変えない（create or replace のため）

create or replace function public.staff_absence_export()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token text := nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-export-token';
  v_id uuid;
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_until date := (now() at time zone 'Asia/Tokyo')::date + 34;
  v_now text := to_char(now() at time zone 'Asia/Tokyo', 'YYYY/MM/DD HH24:MI');
  v_body text;
begin
  if v_token is null or length(v_token) < 32 then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select id into v_id from staff_export_tokens
   where token_sha256 = encode(sha256(convert_to(v_token, 'UTF8')), 'hex') and revoked_at is null;
  if v_id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update staff_export_tokens set last_used_at = now() where id = v_id;

  with
  -- ① 休暇申請（leave_dates があればその日だけ・無ければ開始〜終了）
  lv as (
    select l.user_id, x.d, '休み（終日）'::text as kind, ''::text as tm,
           case when l.status = 'approved' then '受理済み' else '受理待ち' end as st, '休暇申請'::text as src
      from leave_requests l
      cross join lateral (
        select e::date as d
          from jsonb_array_elements_text(case when coalesce(l.leave_dates, '') ~ '^\s*\[\s*"' then l.leave_dates::jsonb else '[]'::jsonb end) e
        union
        select g::date
          from generate_series(l.start_date, l.end_date, interval '1 day') g
         where coalesce(l.leave_dates, '') !~ '^\s*\[\s*"'
      ) x
     where l.status not in ('cancelled', 'rejected')
       and l.end_date >= v_today and l.start_date <= v_until
  ),
  -- ② 残業申請（休暇から自動で作った行は①と重なるので除く）
  ot as (
    select o.*,
           case when o.status in ('request_confirmed', 'reported', 'confirmed') then '受理済み' else '受理待ち' end as st
      from overtime_reports o
     where o.status not in ('cancelled', 'returned') and o.source_leave_request_id is null
       and (o.work_date between v_today and v_until or o.furikae_origin_date between v_today and v_until)
  ),
  ots as (  -- 時間帯：実績があれば実績・無ければ予定
    select o.id, min(s.start_min) as smin, max(s.end_min) as emax
      from ot o
      join overtime_report_segments s on s.report_id = o.id
       and s.phase = case when exists (select 1 from overtime_report_segments z where z.report_id = o.id and z.phase = 'actual')
                          then 'actual' else 'planned' end
     group by o.id
  ),
  otr as (
    select o.applicant_id as user_id, o.work_date as d, k.kind,
           case k.kind
             when '遅出' then coalesce(lpad((t2.smin / 60)::text, 2, '0') || ':' || lpad((t2.smin % 60)::text, 2, '0') || '〜', '')
             when '早退' then coalesce('〜' || lpad((t2.emax / 60)::text, 2, '0') || ':' || lpad((t2.emax % 60)::text, 2, '0'), '')
             when '勤務地変更' then coalesce(o.location, '')
             when '休日出勤' then trim(coalesce(lpad((t2.smin / 60)::text, 2, '0') || ':' || lpad((t2.smin % 60)::text, 2, '0')
                                      || '〜' || lpad((t2.emax / 60)::text, 2, '0') || ':' || lpad((t2.emax % 60)::text, 2, '0'), '')
                                 || ' ' || coalesce(o.location, ''))
             else '' end as tm,
           o.st, '残業申請'::text as src
      from ot o
      left join ots t2 on t2.id = o.id
      cross join lateral unnest(o.application_types) t
      cross join lateral (select case
             when t in ('chosei_off', 'furikae_off') then '休み（終日）'
             when t = 'absence' then '欠勤（終日）'
             when t in ('late_start_adj', 'tardiness') then '遅出'
             when t in ('early_end_adj', 'early_leave') then '早退'
             when t = 'location_change' then '勤務地変更'
             when t = 'holiday_work' then '休日出勤'
           end as kind) k
     where k.kind is not null and o.work_date between v_today and v_until
    union all
    -- 振替休日の振替元の日（その日は休日出勤）
    select o.applicant_id, o.furikae_origin_date, '休日出勤',
           trim(coalesce(to_char(o.furikae_origin_start, 'HH24:MI') || '〜' || to_char(o.furikae_origin_end, 'HH24:MI'), '')
                || ' ' || coalesce(o.furikae_origin_location, '')),
           o.st, '残業申請'
      from ot o
     where 'furikae_off' = any(o.application_types)
       and o.furikae_not_worked_at is null   -- 「この日は勤務しませんでした」と伝えた振替元の日は出さない
       and o.furikae_origin_date between v_today and v_until
  ),
  -- ③ 勤務変更（パート）
  srr as (
    select s.applicant_id as user_id, s.work_date as d, k.kind,
           case k.kind
             when '遅出' then coalesce(to_char(s.actual_start, 'HH24:MI') || '〜', '')
             when '早退' then coalesce('〜' || to_char(s.actual_end, 'HH24:MI'), '')
             when '勤務地変更' then coalesce(s.actual_location, '')
             when '休日出勤' then trim(coalesce(to_char(s.actual_start, 'HH24:MI') || '〜' || to_char(s.actual_end, 'HH24:MI'), '')
                                 || ' ' || coalesce(s.actual_location, ''))
             else '' end as tm,
           case when s.status = 'confirmed' then '受理済み' else '受理待ち' end as st, '勤務変更'::text as src
      from shift_reports s
      cross join lateral unnest(coalesce(s.application_types, array[s.application_type])) t
      cross join lateral (select case
             when t = 'absence' then '欠勤（終日）'
             when t = 'tardiness' then '遅出'
             when t = 'early_leave' then '早退'
             when t = 'location_change' then '勤務地変更'
             when t = 'holiday_work' then '休日出勤'
           end as kind) k
     where k.kind is not null and s.status not in ('cancelled', 'returned')
       and s.work_date between v_today and v_until
  ),
  -- ④ 勤怠カレンダー（上長が入れたもの＝受理済み）
  atr as (
    select a.user_id, a.date as d, k.kind,
           case k.kind
             when '遅出' then coalesce(coalesce(a.work_segments -> 0 ->> 'start', to_char(a.actual_time, 'HH24:MI')) || '〜', '')
             when '早退' then coalesce('〜' || coalesce(a.work_segments -> -1 ->> 'end', to_char(a.actual_time, 'HH24:MI')), '')
             when '勤務地変更' then coalesce(a.location, '')
             when '休日出勤' then trim(coalesce((a.work_segments -> 0 ->> 'start') || '〜' || (a.work_segments -> -1 ->> 'end'), '')
                                 || ' ' || coalesce(a.location, ''))
             when '時間変更' then trim(coalesce((a.work_segments -> 0 ->> 'start') || '〜' || (a.work_segments -> -1 ->> 'end'), '')
                                 || ' ' || coalesce(a.location, ''))
             else '' end as tm,
           '受理済み'::text as st, '勤怠カレンダー'::text as src
      from attendance_exceptions a
      cross join lateral (select case
             when a.type = 'absent' then '欠勤（終日）'
             when a.type in ('late', 'late_start') then '遅出'
             when a.type in ('early_end', 'early_leave') then '早退'
             when a.type = 'location_change' then '勤務地変更'
             when a.type = 'holiday_work' then '休日出勤'
             when a.type = 'time_change' then '時間変更'
           end as kind) k
     where k.kind is not null and a.date between v_today and v_until
  ),
  -- ⑤ 休職（判定は staff_leave_active_on と同じ決め方：復職日と終わった日は休職に数えない）
  slr as (
    select l.user_id, g::date as d, '休み（終日）'::text as kind, ''::text as tm, '受理済み'::text as st, '休職'::text as src
      from staff_leaves l
      cross join lateral generate_series(greatest(l.start_date, v_today), v_until, interval '1 day') g
     where l.cancelled_at is null
       and l.start_date <= v_until
       and (l.return_date is null or l.return_date > g::date)
       and (l.ended_at is null or (l.ended_at at time zone 'Asia/Tokyo')::date > g::date)
  ),
  -- ⑥ シフト調整で正社員の方が代わりに決まり、まだ残業申請を出していないもの（申請の依頼が open のまま）。
  --    出したら依頼は applied になり、②の残業申請として出る（二重にならない）。パートの方は勤怠カレンダー（④）に入るので対象外
  sar as (
    select a.user_id, s.target_date as d,
           case when (public.registered_shift_of(a.user_id, s.target_date)).id is null then '休日出勤' else '時間変更' end as kind,
           trim(coalesce((a.segments -> 0 ->> 'start') || '〜' || (a.segments -> -1 ->> 'end'), '')
                || ' ' || coalesce(a.segments -> 0 ->> 'location', '')) as tm,
           '受理待ち'::text as st, 'シフト調整'::text as src
      from shift_adjust_assignments a
      join shift_adjust_slots s on s.id = a.slot_id
      join application_requests r on r.id = a.application_request_id
     where a.kind = 'overtime_request' and s.status = 'decided' and r.status = 'open'
       and s.target_date between v_today and v_until
  ),
  allr as (
    select * from lv union all select * from otr union all select * from srr union all select * from atr union all select * from slr union all select * from sar
  ),
  rws as (
    select distinct r.d, p.employee_no, p.name, r.kind, r.tm, r.st, r.src,
           coalesce((public.registered_shift_of(p.id, r.d)).location, '') as home
      from allr r
      join profiles p on p.id = r.user_id and p.is_active
     where r.d between v_today and v_until
  ),
  lines as (
    select r.d, r.employee_no, r.name, r.kind, r.src,
           (select string_agg(case when f ~ '[",\r\n]' then '"' || replace(f, '"', '""') || '"' else f end, ',' order by i)
              from unnest(array[v_now, to_char(r.d, 'YYYY/MM/DD'), coalesce(r.employee_no, ''), coalesce(r.name, ''),
                                r.kind, r.tm, r.st, r.src, r.home]) with ordinality as u(f, i)) as line
      from rws r
  )
  select string_agg(line, E'\r\n' order by d, employee_no nulls last, name, kind, src, line)
    into v_body
    from lines;

  return '書き出した時刻,日付,従業員番号,名前,種類,時間,状態,どこから,ふだんの所属校' || E'\r\n'
         || coalesce(v_body || E'\r\n', '');
end;
$$;

comment on function public.staff_absence_export() is
  '班分けのツールへ渡す休み・時間の変更の CSV（今日から35日・見出し x-export-token の合言葉が合うときだけ）。RPA の PC が毎時呼ぶ';

-- 呼べるのは anon だけ（RPA の PC は公開用の鍵で呼ぶ・中で合言葉を確かめる）。ログインした人の画面からは呼ばせない
revoke all on function public.staff_absence_export() from public;
revoke all on function public.staff_absence_export() from authenticated;
grant execute on function public.staff_absence_export() to anon;
