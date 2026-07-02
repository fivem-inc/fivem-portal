-- 忘れん坊通知①②③を毎日自動で呼び出すcronジョブを登録
--   ① encouragement-notify : 有給奨励日の未回答者リマインド（期限3日前・当日）
--   ② remind-scheduled     : 管理者が設定した「毎月◯日」の定期リマインド
--   ③ remind-unread        : 連絡板で期限が今日/明日の投稿の未読者リマインド
-- （手動の「🔔 ○人にリマインドを送る」ボタンはBoardPage.tsxで実装済みのため対象外）
--
-- 実行時刻: 毎日 00:00 UTC（= 日本時間 09:00）
--
-- 前提（board-scheduled-send-every-5-minと同じVaultのservice_role_keyを流用）:
-- 1. pg_net 拡張を有効化済みであること（Database > Extensions > pg_net）
-- 2. vault.decrypted_secrets に name='service_role_key' が登録済みであること
--
-- このファイル自体はSupabase上に実行記録として残すための記録用。
-- 実際の登録はSupabaseダッシュボードのSQL Editorで以下を手動実行する。

select cron.schedule(
  'encouragement-notify-daily',
  '0 0 * * *',
  $$
  select net.http_post(
    url := 'https://xaeynaxctiiyqxjyuzfi.supabase.co/functions/v1/encouragement-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := jsonb_build_object('triggered_at', now())
  ) as request_id;
  $$
);

select cron.schedule(
  'remind-scheduled-daily',
  '0 0 * * *',
  $$
  select net.http_post(
    url := 'https://xaeynaxctiiyqxjyuzfi.supabase.co/functions/v1/remind-scheduled',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := jsonb_build_object('triggered_at', now())
  ) as request_id;
  $$
);

select cron.schedule(
  'remind-unread-daily',
  '0 0 * * *',
  $$
  select net.http_post(
    url := 'https://xaeynaxctiiyqxjyuzfi.supabase.co/functions/v1/remind-unread',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := jsonb_build_object('triggered_at', now())
  ) as request_id;
  $$
);

-- 登録解除する場合:
-- select cron.unschedule('encouragement-notify-daily');
-- select cron.unschedule('remind-scheduled-daily');
-- select cron.unschedule('remind-unread-daily');

-- 登録済みジョブ一覧の確認:
-- select * from cron.job;
