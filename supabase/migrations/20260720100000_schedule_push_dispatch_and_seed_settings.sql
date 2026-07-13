-- プッシュ通知パイプラインのワーカー（push-dispatch）を1分毎に実行するcron登録
-- （既存のboard-scheduled-send等と同じVaultのservice_role_keyパターン）
select cron.schedule(
  'push-dispatch-every-min',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://xaeynaxctiiyqxjyuzfi.supabase.co/functions/v1/push-dispatch',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := jsonb_build_object('triggered_at', now())
  ) as request_id;
  $$
);

-- 管理画面「通知設定」タブでイベント別にプッシュON/OFFできるよう、
-- プッシュ対象（ホワイトリスト）イベントの 'push' チャンネル行をシード（全てON）
-- ※設定行が無いイベントはワーカー側でON扱いだが、画面から制御できるよう明示的に作る
INSERT INTO notification_settings (event_key, channel, enabled)
SELECT v.event_key, 'push', true
FROM (VALUES
  ('leave:new_request'),
  ('leave:leader_approved'),
  ('leave:manager_approved'),
  ('leave:rejected'),
  ('shift_report:new_request'),
  ('shift_report:returned'),
  ('purchase_request:submitted'),
  ('purchase_request:submitted_manager'),
  ('purchase_request:submitted_board'),
  ('purchase_request:manager_opinions_ready'),
  ('purchase_request:returned'),
  ('expense:new_request'),
  ('board:notice'),
  ('board:group_message'),
  ('board:dm_message'),
  ('board:confirm_request'),
  ('reminder:unread'),
  ('reminder:scheduled'),
  ('reminder:encouragement')
) AS v(event_key)
WHERE NOT EXISTS (
  SELECT 1 FROM notification_settings s
  WHERE s.event_key = v.event_key AND s.channel = 'push'
);

-- 登録解除する場合:
-- select cron.unschedule('push-dispatch-every-min');
