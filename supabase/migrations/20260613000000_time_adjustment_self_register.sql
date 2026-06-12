-- 一般社員が自分の late_start / early_end を自己登録できるRLSポリシー
create policy "Users can insert own time adjustments"
  on attendance_exceptions for insert
  with check (
    user_id = auth.uid()
    and created_by = auth.uid()
    and type in ('late_start', 'early_end')
    and date >= current_date
  );

-- 同日・同種別の重複レコードを除去（最新のものを残す）
delete from attendance_exceptions a
using (
  select user_id, date, type, max(created_at) as latest
  from attendance_exceptions
  group by user_id, date, type
  having count(*) > 1
) dup
where a.user_id = dup.user_id
  and a.date = dup.date
  and a.type = dup.type
  and a.created_at < dup.latest;

-- 同日・同種別の重複登録防止
alter table attendance_exceptions
  add constraint uq_attendance_exceptions_user_date_type
  unique (user_id, date, type);
