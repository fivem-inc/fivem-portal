-- 社内お知らせのリマインド（announcement-remind）を毎日自動で呼び出すcronジョブ。
--   終了日が近づいた「表示中・プッシュリマインドON」のお知らせを念押し送信する。
--
-- 実行時刻: 毎日 00:00 UTC（= 日本時間 09:00）
--
-- 前提（既存の push-dispatch / remind-scheduled と同じVaultのservice_role_keyを流用）:
-- 1. pg_net 拡張を有効化済みであること（Database > Extensions > pg_net）
-- 2. vault.decrypted_secrets に name='service_role_key' が登録済みであること
--
-- このファイルは実行記録用。実際の登録はSupabaseダッシュボードのSQL Editorで手動実行する。

select cron.schedule(
  'announcement-remind-daily',
  '0 0 * * *',
  $$
  select net.http_post(
    url := 'https://xaeynaxctiiyqxjyuzfi.supabase.co/functions/v1/announcement-remind',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := jsonb_build_object('triggered_at', now())
  ) as request_id;
  $$
);

-- 登録解除する場合:
-- select cron.unschedule('announcement-remind-daily');

-- 登録済みジョブ一覧の確認:
-- select * from cron.job;
