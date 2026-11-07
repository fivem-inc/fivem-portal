-- ============================================================
-- 2026-11-07  勤怠カレンダーの予定の「報告／申請がまだ」のお知らせ（ユーザー確定）
-- ============================================================
-- ① パートの方（勤務変更）：下の行の書き方を「勤怠カレンダー：欠勤」→「上長が入れた予定：欠勤」にそろえる（中身の決まりは 20261107121551 のまま）
-- ② 正社員の方（残業申請）＝B：上長が勤怠カレンダーに入れた予定で、本人の残業申請・休暇申請がまだの日を毎朝9時に本人へ（ベル＋スマホ）
--    文：「📅 残業申請がまだの日が1件あります」／下に「11/2（上長が入れた予定：勤務地変更）」
--    対象：種類は勤務変更と同じ6つ／75日前〜14日先／締め（payroll_close_passed）の前／
--          その日（振替元の日を含む）に取消・却下でない残業申請が無い／その日を含む取消・却下でない休暇申請が無い／
--          その日の申請の依頼が open で来ていない（依頼のお知らせと二重にしない）
--    何を数えるかは overtime_calendar_unapplied_rows 1か所。通知設定 overtime:calendar_unapplied（site・push）で止められる

create or replace function public.shift_report_unreported_rows()
returns table (user_id uuid, work_date date, kind text, label text)
language sql
stable
security definer
set search_path to 'public'
as $$
  with t as (select (now() at time zone 'Asia/Tokyo')::date as today)
  -- 受理済みの事前申請で、日が過ぎたもの
  select r.applicant_id, r.work_date, 'advance'::text, '事前申請'::text
    from shift_reports r, t
   where r.status = 'request_confirmed' and r.advance and r.work_date < t.today
  union all
  -- 勤怠カレンダーの予定で、日が過ぎてもまだ勤務変更が無いもの（同じ日に予定が2つでも1日1件）
  select distinct on (ae.user_id, ae.date)
         ae.user_id, ae.date, 'calendar'::text,
         ('上長が入れた予定：' || case ae.type
            when 'absent' then '欠勤' when 'holiday_work' then '休日出勤' when 'location_change' then '勤務地変更'
            when 'late' then '遅刻' when 'early_leave' then '早退' else '勤務時間変更' end)::text
    from attendance_exceptions ae
    join profiles p on p.id = ae.user_id and coalesce(p.employment_type, '') <> '正社員', t
   where ae.type in ('absent', 'holiday_work', 'location_change', 'late', 'early_leave', 'time_change')
     and ae.date < t.today
     and ae.date >= t.today - 75
     and not public.payroll_close_passed(ae.date)
     and not exists (select 1 from shift_reports s where s.applicant_id = ae.user_id and s.work_date = ae.date)
   order by 1, 2, 3
$$;
revoke all on function public.shift_report_unreported_rows() from public;
revoke execute on function public.shift_report_unreported_rows() from anon;
revoke execute on function public.shift_report_unreported_rows() from authenticated;


create or replace function public.overtime_calendar_unapplied_rows()
returns table (user_id uuid, work_date date, label text)
language sql
stable
security definer
set search_path to 'public'
as $$
  with t as (select (now() at time zone 'Asia/Tokyo')::date as today)
  select distinct on (ae.user_id, ae.date)
         ae.user_id, ae.date,
         ('上長が入れた予定：' || case ae.type
            when 'absent' then '欠勤' when 'holiday_work' then '休日出勤' when 'location_change' then '勤務地変更'
            when 'late' then '遅刻' when 'early_leave' then '早退' else '勤務時間変更' end)::text
    from attendance_exceptions ae
    join profiles p on p.id = ae.user_id and p.employment_type = '正社員' and p.is_active, t
   where ae.type in ('absent', 'holiday_work', 'location_change', 'late', 'early_leave', 'time_change')
     and ae.date >= t.today - 75
     and ae.date <= t.today + 14
     and not public.payroll_close_passed(ae.date)
     and not exists (select 1 from overtime_reports r
                      where r.applicant_id = ae.user_id
                        and (r.work_date = ae.date or r.furikae_origin_date = ae.date)
                        and r.status not in ('cancelled', 'rejected'))
     and not exists (select 1 from leave_requests l
                      where l.user_id = ae.user_id and ae.date between l.start_date and l.end_date
                        and l.status not in ('cancelled', 'rejected'))
     and not exists (select 1 from application_requests q
                      where q.recipient_id = ae.user_id and q.status = 'open'
                        and ae.date::text = any(q.target_dates::text[]))
   order by ae.user_id, ae.date, ae.type
$$;
revoke all on function public.overtime_calendar_unapplied_rows() from public;
revoke execute on function public.overtime_calendar_unapplied_rows() from anon;
revoke execute on function public.overtime_calendar_unapplied_rows() from authenticated;

create or replace function public.overtime_calendar_unapplied_notify()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_n integer := 0;
begin
  -- 積み上がらないよう、まだ閉じていない分を消して付け直す（解決した日は消える）
  delete from notifications
   where source_type = 'overtime:calendar_unapplied' and coalesce(dismissed, false) = false;

  if exists (select 1 from notification_settings
              where event_key = 'overtime:calendar_unapplied' and channel = 'site' and enabled = false) then
    return 0;
  end if;

  insert into notifications (user_id, message, sub_message, source_type, event_key, reference_id)
  select x.user_id,
         '📅 残業申請がまだの日が' || count(*) || '件あります',
         string_agg(to_char(x.work_date, 'FMMM/FMDD') || '（' || x.label || '）', '・' order by x.work_date),
         'overtime:calendar_unapplied', 'overtime:calendar_unapplied', v_today::text
    from public.overtime_calendar_unapplied_rows() x
   group by x.user_id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$function$;
revoke all on function public.overtime_calendar_unapplied_notify() from public;
revoke execute on function public.overtime_calendar_unapplied_notify() from anon;
revoke execute on function public.overtime_calendar_unapplied_notify() from authenticated;

insert into notification_settings (event_key, channel, enabled)
select k, c, true from (values ('overtime:calendar_unapplied', 'site'), ('overtime:calendar_unapplied', 'push')) v(k, c)
 where not exists (select 1 from notification_settings s where s.event_key = v.k and s.channel = v.c);

-- 毎朝 9:00 JST（勤務変更の報告まちと同じ時刻）
select cron.unschedule('overtime-calendar-unapplied-daily') where exists (select 1 from cron.job where jobname = 'overtime-calendar-unapplied-daily');
select cron.schedule('overtime-calendar-unapplied-daily', '0 0 * * *', 'select public.overtime_calendar_unapplied_notify()');
-- 戻すとき：select cron.unschedule('overtime-calendar-unapplied-daily'); delete from notification_settings where event_key = 'overtime:calendar_unapplied';
