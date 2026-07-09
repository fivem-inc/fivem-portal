-- ストレージ容量チェックのcron頻度を月次→週次に変更（早期にアラートに気づけるように）

select cron.unschedule('storage-usage-check-monthly');

-- 毎週月曜 0:00 UTC（日本時間 9:00）にstorage-usage-check Edge Functionを呼び出す
select cron.schedule(
  'storage-usage-check-weekly',
  '0 0 * * 1',
  $$
  select net.http_post(
    url := 'https://xaeynaxctiiyqxjyuzfi.supabase.co/functions/v1/storage-usage-check',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := jsonb_build_object('triggered_at', now())
  ) as request_id;
  $$
);

-- 登録解除する場合:
-- select cron.unschedule('storage-usage-check-weekly');
