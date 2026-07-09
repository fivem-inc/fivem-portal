-- ストレージ容量の定期確認機能
-- 1. 管理画面から即座に現在使用量を見れるRPC関数
-- 2. 毎月1回、閾値を超えたら自動でアラートするcronジョブ（storage-usage-check Edge Function経由）

create or replace function public.get_storage_usage_mb()
returns numeric
language sql
security definer
as $$
  select round(coalesce(sum((metadata->>'size')::bigint), 0) / 1024.0 / 1024.0, 1)
  from storage.objects;
$$;

revoke all on function public.get_storage_usage_mb() from public;
grant execute on function public.get_storage_usage_mb() to authenticated;

-- 毎月1日 0:00 UTC（日本時間 9:00）にstorage-usage-check Edge Functionを呼び出す
select cron.schedule(
  'storage-usage-check-monthly',
  '0 0 1 * *',
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
-- select cron.unschedule('storage-usage-check-monthly');
