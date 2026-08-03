-- ========================================
-- 安否確認の自動リマインド：深夜に鳴らさない時間帯（発信ごとに設定する）
--   発信画面で毎回選べるようにする。既定値はパターンで変える：
--     ・安否確認（safety3/safety4）＝災害なので 24時間いつでも
--     ・出勤確認・応援要請（attendance2/support）＝業務連絡なので 7:00〜22:00
--
--   ⚠️ 時間帯外は「送らずに待つ」。next_remind_at を進めてしまうと、
--     鳴らさなかった回まで回数を消費して、朝になったときに催促できなくなるため。
-- ========================================

alter table safety_checks
  add column if not exists remind_start_hour int not null default 0   check (remind_start_hour between 0 and 23),
  add column if not exists remind_end_hour   int not null default 24  check (remind_end_hour   between 1 and 24);

-- claim関数を時間帯対応にする（p_hour_jst＝いまのJSTの時。Edge Functionが渡す）
drop function if exists claim_safety_check_reminders(timestamptz);
drop function if exists claim_safety_check_reminders(timestamptz, int, int, int);

create or replace function claim_safety_check_reminders(p_now timestamptz, p_hour_jst int)
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
     -- 発信時に決めた時間帯の中だけ送る（0〜24なら24時間いつでも＝常に真）
     and p_hour_jst >= remind_start_hour
     and p_hour_jst <  remind_end_hour
  returning safety_checks.id, safety_checks.pattern;
$$;

revoke all on function claim_safety_check_reminders(timestamptz, int) from public, authenticated;

-- 発信ごとの設定にしたので、共通設定は使わない（作ってあれば消す）
delete from app_settings where key = 'safety_remind_quiet_hours';
