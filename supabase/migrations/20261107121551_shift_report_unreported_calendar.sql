-- ============================================================
-- 2026-11-07  勤務変更の「報告がまだの日」のお知らせに、勤怠カレンダーの予定も足す（ユーザー確定 案1：事前申請とまとめて1通）
-- ============================================================
-- ・これまで：毎朝9時のお知らせ（shift_report_unreported_notify）は、受理済みの事前申請で日が過ぎたものだけ。
--   上長が勤怠カレンダーに入れた予定（パートの方の欠勤・休日出勤など）は、勤務変更のページを開かないと気づけなかった
-- ・何を数えるかは shift_report_unreported_rows 1か所（毎朝のお知らせと、ナビの数字 my_shift_report_unreported_count が使う）
-- ・勤怠カレンダーの予定の決まりは画面の lib/shiftReportTodo の classifyEntry と同じ：
--   種類（absent・holiday_work・location_change・late・early_leave・time_change）／締め（payroll_close_passed）の前／
--   同じ勤務日の勤務変更が1件も無い。お知らせは日が過ぎた分（当日の分は翌朝から）。正社員の方は外す（勤務変更はパートの方だけ）
-- ・文：「⏰ 勤務変更の報告がまだの日が3件あります」／下に「11/4（事前申請）・11/5（勤怠カレンダー：欠勤）」
-- ・代わりに出した方へのベル（事前申請だけ）は今までどおり

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
         ('勤怠カレンダー：' || case ae.type
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

-- ナビの「勤務変更」の数字（自分の分＋代わりに出した事前申請）
create or replace function public.my_shift_report_unreported_count()
returns integer
language sql
stable
security definer
set search_path to 'public'
as $$
  select (select count(*) from public.shift_report_unreported_rows() x where x.user_id = auth.uid())::integer
       + (select count(*) from shift_reports r
           where r.submitted_by = auth.uid() and r.applicant_id <> auth.uid()
             and r.status = 'request_confirmed' and r.advance
             and r.work_date < (now() at time zone 'Asia/Tokyo')::date)::integer
$$;
revoke all on function public.my_shift_report_unreported_count() from public;
revoke execute on function public.my_shift_report_unreported_count() from anon;
grant execute on function public.my_shift_report_unreported_count() to authenticated;

-- 毎朝のお知らせ（本番の実定義から・ご本人の分だけ差し替え）
CREATE OR REPLACE FUNCTION public.shift_report_unreported_notify()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_n integer := 0;
  v_m integer := 0;
begin
  delete from notifications
   where source_type in ('shift_report:unreported', 'shift_report:unreported_proxy')
     and coalesce(dismissed, false) = false;

  if exists (select 1 from notification_settings
              where event_key = 'shift_report:unreported' and channel = 'site' and enabled = false) then
    return 0;
  end if;

  -- ご本人（ベル＋スマホ）：事前申請と勤怠カレンダーの予定をまとめて1通（2026-11-07）
  insert into notifications (user_id, message, sub_message, source_type, event_key, reference_id)
  select x.user_id,
         '⏰ 勤務変更の報告がまだの日が' || count(*) || '件あります',
         string_agg(to_char(x.work_date, 'FMMM/FMDD') || '（' || x.label || '）', '・' order by x.work_date, x.kind),
         'shift_report:unreported', 'shift_report:unreported', v_today::text
    from public.shift_report_unreported_rows() x
    join profiles p on p.id = x.user_id and p.is_active
   group by x.user_id;
  get diagnostics v_n = row_count;

  -- 代わりに出した方（ベルだけ・事前申請だけ・今までどおり）
  insert into notifications (user_id, message, sub_message, source_type, reference_id)
  select r.submitted_by,
         '⏰ 代わりに出した事前申請で、報告が必要なものが' || count(*) || '件あります',
         string_agg(coalesce(a.name, '') || 'さん ' || to_char(r.work_date, 'FMMM/FMDD'), '・' order by r.work_date),
         'shift_report:unreported_proxy', v_today::text
    from shift_reports r
    join profiles s on s.id = r.submitted_by and s.is_active
    left join profiles a on a.id = r.applicant_id
   where r.status = 'request_confirmed' and r.advance and r.work_date < v_today
     and r.submitted_by is not null and r.submitted_by <> r.applicant_id
   group by r.submitted_by;
  get diagnostics v_m = row_count;

  return v_n + v_m;
end;
$function$;
