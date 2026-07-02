-- 忘れん坊通知①②③のcronを「毎日1回固定時刻」から「5分おきに実行して、
-- 各Edge Function内で reminder_days_settings の send_hour/send_minute と
-- 今の時刻(JST)が一致するかチェックする」方式に変更する
-- （board-scheduled-send-every-5-minと同じ間隔）
--
-- これにより、管理画面から時刻を変更するだけで反映されるようになる
-- （cronの再設定が不要になる）

select cron.alter_job(
  (select jobid from cron.job where jobname = 'encouragement-notify-daily'),
  schedule := '*/5 * * * *'
);

select cron.alter_job(
  (select jobid from cron.job where jobname = 'remind-scheduled-daily'),
  schedule := '*/5 * * * *'
);

select cron.alter_job(
  (select jobid from cron.job where jobname = 'remind-unread-daily'),
  schedule := '*/5 * * * *'
);
