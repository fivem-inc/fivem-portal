alter table attendance_exceptions
  drop constraint attendance_exceptions_type_check;

alter table attendance_exceptions
  add constraint attendance_exceptions_type_check
    check (type in ('late', 'early_leave', 'absent', 'late_start', 'early_end'));
