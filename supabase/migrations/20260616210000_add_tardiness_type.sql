-- application_type に 'tardiness'（遅刻）を追加
alter table shift_reports
  drop constraint shift_reports_application_type_check;

alter table shift_reports
  add constraint shift_reports_application_type_check
  check (application_type in ('overtime', 'early_leave', 'tardiness', 'absence'));
