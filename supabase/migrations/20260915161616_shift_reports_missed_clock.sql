-- 勤務変更の種別に「打刻忘れ」（missed_clock）を足す（2026-09-15 ユーザー依頼・至急）
-- 「何か選ばないといけないのに、打刻忘れのときに当てはまる種別が無い」ため。
-- 🚨 種別の一覧は画面（pages/ShiftReportPage.tsx・admin/ShiftReportsTab.tsx・admin/ShiftEditModal.tsx）と
--    Edge Function shift-report-confirmed-notify のラベルにもある。足すときは全部そろえる
-- 🚨 application_types（配列）には制約が無い。主の種別 application_type だけがこの制約で見られる

alter table public.shift_reports drop constraint if exists shift_reports_application_type_check;
alter table public.shift_reports add constraint shift_reports_application_type_check
  check (application_type = any (array[
    'overtime', 'holiday_work', 'early_leave', 'tardiness', 'absence', 'early_start', 'location_change', 'missed_clock'
  ]::text[]));
