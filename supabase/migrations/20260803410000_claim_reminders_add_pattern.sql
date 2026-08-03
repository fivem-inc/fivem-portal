-- 自動リマインドのプッシュ文面をパターンで出し分けるため、claim時に pattern も返す
--   （応援のお願い＝「ファイブM 連絡板」、安否・出勤確認＝「ファイブM 緊急」）
-- 戻り値の型が変わるので drop してから作り直す

drop function if exists claim_safety_check_reminders(timestamptz);

create or replace function claim_safety_check_reminders(p_now timestamptz)
returns table(id uuid, pattern text)
language sql
security definer
set search_path = public
as $$
  update safety_checks
     set remind_count = remind_count + 1,
         next_remind_at = case
           when remind_count + 1 >= remind_max then null
           else p_now + make_interval(mins => remind_interval_min)
         end
   where status = 'active'
     and cancelled = false
     and next_remind_at is not null
     and next_remind_at <= p_now
     and remind_count < remind_max
  returning safety_checks.id, safety_checks.pattern;
$$;

revoke all on function claim_safety_check_reminders(timestamptz) from public, authenticated;
