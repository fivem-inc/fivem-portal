-- 2026-10-28 班分けのツールへ渡す「休み・時間の変更」の一覧（ユーザー確定）
-- RPA の PC が 8:00〜23:00 の毎時、この関数を呼んで CSV を NAS に置く（ツールはそのファイルを読む）。
-- ・読めるのは合言葉（見出し x-export-token）が合うときだけ。合言葉そのものは DB に置かず、SHA-256 だけを持つ
-- ・今日から35日先まで。取消・差し戻し（却下）は入れない。受理待ちは「受理待ち」として入れる。休暇の理由は入れない
-- ・列：書き出した時刻,日付,従業員番号,名前,種類,時間,状態,どこから,ふだんの所属校（UTF-8・CRLF。BOM は RPA の側で付ける）
-- ・種類：休み（終日）／欠勤（終日）／遅出／早退／勤務地変更／休日出勤／時間変更
-- 🚨 申請の種類を足したら、ここの対応も見直す（足さないと CSV に出ない＝ツールでは「いる」扱いになる）

create table public.staff_export_tokens (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  token_sha256 text not null unique check (token_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
alter table public.staff_export_tokens enable row level security;
-- 画面からは読み書きさせない（ポリシーなし・権限は service_role だけ）
revoke all on public.staff_export_tokens from anon, authenticated;
grant all on public.staff_export_tokens to service_role;
comment on table public.staff_export_tokens is '外部への書き出し（staff_absence_export）の合言葉。SHA-256 だけを持つ';

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
     where o.status <> 'cancelled' and o.source_leave_request_id is null
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
     where k.kind is not null and s.status not in ('cancelled', 'rejected')
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
             when a.type = 'early_end' then '早退'
             when a.type = 'location_change' then '勤務地変更'
             when a.type = 'holiday_work' then '休日出勤'
             when a.type = 'time_change' then '時間変更'
           end as kind) k
     where k.kind is not null and a.date between v_today and v_until
  ),
  allr as (
    select * from lv union all select * from otr union all select * from srr union all select * from atr
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
