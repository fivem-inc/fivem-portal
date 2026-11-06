-- ============================================================
-- 2026-11-06  勤務変更の事前申請の「報告がまだ」のお知らせ（毎朝 9:00 JST）
-- ============================================================
-- ・対象：受理済み（request_confirmed）の事前申請で、その日が過ぎたもの（＝その日の勤務のあとに報告していない）
-- ・ご本人：ベル＋スマホ（event_key shift_report:unreported・文「⏰ 報告が必要な事前申請が2件あります」＝ユーザー確定 案A）
-- ・代わりに出した方（submitted_by がご本人と違う）：ベルだけ（event_key なし＝スマホなし・ユーザー確定 案1）
-- ・毎朝、まだ開いていない（dismissed=false）このお知らせを消して付け直す＝たまらない・報告すれば翌朝から出ない（残業の remind-overtime-unreported と同じ形）
-- ・在籍の方だけ。🚨 通知設定（site）をオフにすると両方とも作らない。push は push-dispatch の EVENT_MAP と通知設定（push）に従う
-- ・🚨 新しいお知らせは「設定が無い＝全員」になりやすいので、通知設定の行を先に入れる
-- 画面：App.tsx classifyNotif（→ /shift-report?tab=history）・ナビの「⏰ 勤務変更」の数（useShiftPendingCount）・NotificationsTab

begin;

insert into notification_settings (event_key, channel, enabled)
select v.e, v.c, true
  from (values ('shift_report:unreported', 'site'), ('shift_report:unreported', 'push')) v(e, c)
 where not exists (select 1 from notification_settings s where s.event_key = v.e and s.channel = v.c);

create or replace function public.shift_report_unreported_notify()
returns integer
language plpgsql
security definer
set search_path = public
as $$
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

  -- ご本人（ベル＋スマホ）
  insert into notifications (user_id, message, sub_message, source_type, event_key, reference_id)
  select r.applicant_id,
         '⏰ 報告が必要な事前申請が' || count(*) || '件あります',
         string_agg(to_char(r.work_date, 'FMMM/FMDD'), '・' order by r.work_date),
         'shift_report:unreported', 'shift_report:unreported', v_today::text
    from shift_reports r
    join profiles p on p.id = r.applicant_id and p.is_active
   where r.status = 'request_confirmed' and r.advance and r.work_date < v_today
   group by r.applicant_id;
  get diagnostics v_n = row_count;

  -- 代わりに出した方（ベルだけ）
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
$$;

revoke execute on function public.shift_report_unreported_notify() from public;
revoke execute on function public.shift_report_unreported_notify() from anon;
revoke execute on function public.shift_report_unreported_notify() from authenticated;

-- 毎朝 9:00 JST（= 0:00 UTC）。DB の中だけで動く（Edge Function を呼ばない＝ログが増えない）
select cron.unschedule('shift-report-unreported-daily') where exists (select 1 from cron.job where jobname = 'shift-report-unreported-daily');
select cron.schedule('shift-report-unreported-daily', '0 0 * * *', $c$select public.shift_report_unreported_notify()$c$);

commit;
-- 戻すとき：select cron.unschedule('shift-report-unreported-daily'); drop function public.shift_report_unreported_notify();
