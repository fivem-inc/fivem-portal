-- 残業「実績未報告」リマインド：通知設定 seed ＋ 日次 cron
-- Edge: remind-overtime-unreported（受理済み・勤務日超過・終日以外を本人へ日次ベル＋push＋メール）
-- push文面は push-dispatch の EVENT_MAP('overtime:unreported'→残業/新着) を使用。
-- 実行はダッシュボードのSQL Editorで手動。前提: pg_net 有効・vault に service_role_key 登録済み。

-- 1) 通知設定（管理画面でON/OFF）。site/push はフラグ用（本文はEdge・push-dispatchが生成）。email は文面あり。
insert into notification_settings (event_key, channel, enabled, recipient, subject, template) values
  ('overtime:unreported', 'site',  true,  null, null, null),
  ('overtime:unreported', 'push',  true,  null, null, null),
  ('overtime:unreported', 'email', true,  null, '残業の実績報告のお願い',
     '実績の報告がまだの残業が {{件数}} 件あります。\n対象日：{{日付}}\n\n下記から実績を報告してください。\n{{リンク}}')
on conflict (event_key, channel) do nothing;

-- 2) 日次 cron（毎日 00:00 UTC = JST 09:00）
select cron.schedule(
  'remind-overtime-unreported-daily',
  '0 0 * * *',
  $$
  select net.http_post(
    url := 'https://xaeynaxctiiyqxjyuzfi.supabase.co/functions/v1/remind-overtime-unreported',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := jsonb_build_object('triggered_at', now())
  ) as request_id;
  $$
);

-- 登録解除: select cron.unschedule('remind-overtime-unreported-daily');
-- ジョブ確認: select * from cron.job;
