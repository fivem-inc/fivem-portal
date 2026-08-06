-- 管理者の入力もれ通知（admin:setup_alert）の設定行。
--
-- ⚠️ 行が無いイベントは管理画面の通知設定に出てこない。
--    新しい通知を作るときは、必ずこの seed を先に流してから Edge Function をデプロイする。
--
-- 既定：
--   site  = ON  … 経理は業務で定期的に画面を開くため、ベルとバッジで気づく運用
--   slack = OFF … 送信先を選んでから ON にしてもらう（誤って全チャンネルに流さないため）
--   push  は作らない … 本人の希望により、この通知はベルとバッジで受ける
--
-- 宛先は管理者＋社長。Edge Function 側で app_metadata.role='admin' と
-- profiles.role_title='社長' を解決するため、recipient は説明用の値のみ入れている。

insert into notification_settings (event_key, channel, enabled, recipient, subject, template) values
  ('admin:setup_alert', 'site',  true,  '{"roles":["管理者","社長"]}', null,
   '{{件名}}'),
  ('admin:setup_alert', 'slack', false, '{"channels":[]}', null, null)
on conflict (event_key, channel) do nothing;
