-- 勤務変更はパートの方だけ（2026-10-17 ユーザー確定）
-- ・正社員の残業・早退・遅刻・欠勤は残業申請で出す決まり。勤務変更のページは上長（フロア責任者以上・すべて正社員）も開けるため、
--   上長が自分の分を勤務変更で出せてしまっていた（10/16 に1件・9/16 に1件。残業の集計に入らない）
-- ・新しく出すとき（insert）に、本人（applicant_id）が正社員なら止める。代わりに出す人（submitted_by）が正社員なのはよい（パートの方の代行）
-- ・今までに出ている分（update）は止めない（直す・受理する・取り消すができなくなるため）
-- ・画面（ShiftReportPage）でも正社員の上長は「対象スタッフ」で自分を選べない。ここは画面をすり抜けたときの止め

begin;

create or replace function public.enforce_shift_report_part_only()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if exists (select 1 from profiles p where p.id = new.applicant_id and p.employment_type = '正社員') then
    raise exception 'SHIFT_REPORT_FULLTIME: 正社員の方の残業・早退・遅刻・欠勤は「残業申請」から申請してください'
      using errcode = '22023';
  end if;
  return new;
end;
$function$;

revoke execute on function public.enforce_shift_report_part_only() from public;
revoke execute on function public.enforce_shift_report_part_only() from anon;
revoke execute on function public.enforce_shift_report_part_only() from authenticated;

drop trigger if exists trg_shift_report_part_only on public.shift_reports;
create trigger trg_shift_report_part_only
  before insert on public.shift_reports
  for each row execute function public.enforce_shift_report_part_only();

commit;
