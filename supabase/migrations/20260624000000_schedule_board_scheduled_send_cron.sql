-- 連絡板「予約送信」を5分間隔で実際に送信処理するcronジョブを登録
-- 実行内容: board-scheduled-send Edge Function を呼び出す
--   → 予約時刻を過ぎたメッセージの status を 'scheduled' → 'sent' に更新（送信トレイのタブが移動する）
--   → 受信者へベル通知を送信
--
-- 前提（Supabaseダッシュボードで事前に1回だけ実施）:
-- 1. pg_net 拡張を有効化（Database > Extensions > pg_net）
-- 2. service role keyをVaultに保存（SQL Editorで以下を1回実行。実際のキーに置き換える）
--    select vault.create_secret('（service_role_keyの値）', 'service_role_key');
--    ※ すでに同名のsecretがある場合は vault.update_secret を使う
--
-- このファイル自体はSupabase上に実行記録として残すための記録用。
-- 実際の登録はSupabaseダッシュボードのSQL Editorで以下を手動実行する。

select cron.schedule(
  'board-scheduled-send-every-5-min',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://xaeynaxctiiyqxjyuzfi.supabase.co/functions/v1/board-scheduled-send',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := jsonb_build_object('triggered_at', now())
  ) as request_id;
  $$
);

-- 登録解除する場合:
-- select cron.unschedule('board-scheduled-send-every-5-min');

-- 登録済みジョブ一覧の確認:
-- select * from cron.job;
