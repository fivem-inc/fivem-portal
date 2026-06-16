-- 休日出勤（holiday_work）種別を shift_reports に追加
alter table shift_reports drop constraint shift_reports_application_type_check;
alter table shift_reports add constraint shift_reports_application_type_check
  check (application_type in ('overtime', 'holiday_work', 'early_leave', 'tardiness', 'absence'));
