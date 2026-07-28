-- 同じ人・同じ日に矛盾する勤怠が同時に登録されるのを防ぐ。
--
-- 入力画面では1回の登録の中で排他にしているが、2回に分けて登録すると素通りしてしまう
-- （例：先に「全欠勤」を登録し、あとから「休日出勤」を登録する）。
-- 画面のチェックだけでは防げないので、DB側でも同じルールを強制する。
--
-- ルール（入力画面の排他と同じ）:
--   ・全欠勤 / 休日出勤 … その日は単独。他のどの種別とも同居できない
--   ・遅刻 ⇔ 遅出(調整) … どちらか一方
--   ・早退 ⇔ 早退(調整) … どちらか一方
--   ・勤務地変更は遅刻・早退などと同時に登録できる（普段と違う校で、しかも遅刻、はあり得るため）

create or replace function public.enforce_attendance_exclusive()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  conflict_type  text;
  conflict_label text;
begin
  if NEW.type in ('absent', 'holiday_work') then
    -- 単独種別：同じ日に何かあれば必ず衝突
    select type into conflict_type
      from attendance_exceptions
     where user_id = NEW.user_id
       and date = NEW.date
       and (NEW.id is null or id <> NEW.id)
     limit 1;
  else
    select type into conflict_type
      from attendance_exceptions
     where user_id = NEW.user_id
       and date = NEW.date
       and (NEW.id is null or id <> NEW.id)
       and (
         -- 単独種別が既にある日には他を足せない
         type in ('absent', 'holiday_work')
         -- 出勤側・退勤側はそれぞれ一方のみ
         or (NEW.type in ('late', 'late_start')        and type in ('late', 'late_start'))
         or (NEW.type in ('early_leave', 'early_end')  and type in ('early_leave', 'early_end'))
       )
     limit 1;
  end if;

  if conflict_type is not null then
    conflict_label := case conflict_type
      when 'absent'          then '全欠勤'
      when 'holiday_work'    then '休日出勤'
      when 'late'            then '遅刻'
      when 'late_start'      then '遅出(調整)'
      when 'early_leave'     then '早退'
      when 'early_end'       then '早退(調整)'
      when 'location_change' then '勤務地変更'
      else conflict_type
    end;
    raise exception '同じ日にすでに「%」が登録されています。先にそちらを取消してから登録してください。', conflict_label
      using errcode = '23514';
  end if;

  return NEW;
end;
$$;

drop trigger if exists trg_enforce_attendance_exclusive on attendance_exceptions;

create trigger trg_enforce_attendance_exclusive
  before insert or update of type, user_id, date on attendance_exceptions
  for each row
  execute function public.enforce_attendance_exclusive();
