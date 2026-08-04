-- 残業しきい値のお知らせ（毎月の指定日）を毎朝チェックする
--
-- Edge Function 側で「今日が指定日か（既定 25日・5日）」を判定し、
-- 対象でなければ何もせず終了する。毎朝1回だけ叩けばよい。
-- 実行時刻は他の日次リマインドと揃えて UTC 0:00（＝JST 9:00）。

select cron.schedule(
  'remind-overtime-threshold-daily',
  '0 0 * * *',
  $$
  select net.http_post(
    url := 'https://xaeynaxctiiyqxjyuzfi.supabase.co/functions/v1/remind-overtime-threshold',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := jsonb_build_object('triggered_at', now())
  ) as request_id;
  $$
);

-- 登録解除: select cron.unschedule('remind-overtime-threshold-daily');
-- ジョブ確認: select * from cron.job;
