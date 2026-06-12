-- 一般社員が自分の late_start / early_end を自己登録できるRLSポリシー
create policy "Users can insert own time adjustments"
  on attendance_exceptions for insert
  with check (
    user_id = auth.uid()
    and created_by = auth.uid()
    and type in ('late_start', 'early_end')
    and date >= current_date
  );

-- 同日・同種別の重複登録防止
alter table attendance_exceptions
  add constraint uq_attendance_exceptions_user_date_type
  unique (user_id, date, type);
