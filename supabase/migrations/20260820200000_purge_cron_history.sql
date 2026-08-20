-- 自動実行（cron）の記録を毎日掃除する
--
-- 【背景】
-- pg_cron は実行のたびに cron.job_run_details に記録を残すが、
-- 誰も消していなかったため 130,817件・115MB まで膨らんでいた。
-- データベース全体136MBのうち87%がこの記録で、実際の業務データは8MBしかなかった。
-- 無料枠は500MBなので、このままだと約9ヶ月で上限に達し、
-- 上限に達するとデータベースが読み取り専用になって申請が保存できなくなる。
--
-- 【なぜ増えるか】
-- push-dispatch が1分ごと（1日1440件）、その他5分ごとのcronが5本（1日1440件）で
-- 合わせて1日約2,900件たまる。
--
-- 【方針】
-- 直近7日分だけ残す（障害を調べるには十分）。7日分で約2万件・10MB程度。
-- 毎日消すので autovacuum が領域を再利用でき、VACUUM FULL は不要。
-- ※今回の初回掃除では、削除だけでは領域が空かないため VACUUM FULL を1回実行した
--   （136MB → 32MB）。

select cron.unschedule('purge-cron-history-daily')
where exists (select 1 from cron.job where jobname = 'purge-cron-history-daily');

-- JST 3:30（UTC 18:30）。delete-old-notifications（UTC 18:00）の30分後にずらしてある
select cron.schedule(
  'purge-cron-history-daily',
  '30 18 * * *',
  $$ delete from cron.job_run_details where start_time < now() - interval '7 days'; $$
);
