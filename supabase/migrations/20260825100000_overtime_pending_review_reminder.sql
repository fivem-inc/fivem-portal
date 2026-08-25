-- 残業「受理まち」リマインド（確認者あて）：通知設定 seed ＋ 日次 cron
--
-- Edge: remind-overtime-pending-review
--   受理まち(requested)で勤務日を過ぎた申請を、確認者ごとに集計して日次でベル＋push＋メール。
--   本人あての remind-overtime-unreported（実績未報告）と対になる仕組み。
--
-- 【背景】
-- 残業の事前申請は、申請したときに1回だけ確認者へ通知が飛ぶ。
-- その通知を見落とすと、そのあと催促が一度も来ないため、
-- 「申請したのに受理されないまま勤務日が過ぎる」ことが起きていた。
--
-- 🚨 seed を先に流してから Edge Function をデプロイすること。
--    push-dispatch は「設定行が無い event_key は ON 扱い」で送るため、
--    先に行を作っておかないと管理画面から止められない状態になる（キルスイッチが無い）。
--
-- 🚨 メール本文の改行は E'...' で書く。ふつうの '...' だと \n が
--    バックスラッシュと n の2文字のままDBに入り、メールにそのまま出る（過去に2回発生）。
--
-- 実行はダッシュボードのSQL Editorで手動。前提: pg_net 有効・vault に service_role_key 登録済み。

-- 1) 通知設定（管理画面でON/OFF）。site/push はフラグ用（本文はEdge・push-dispatchが生成）。
--    メールは既定OFF（毎日届くと多いため。必要なら管理画面でONにする）
insert into notification_settings (event_key, channel, enabled, recipient, subject, template) values
  ('overtime:pending_review', 'site',  true,  null, null, null),
  ('overtime:pending_review', 'push',  true,  null, null, null),
  ('overtime:pending_review', 'email', false, null, '残業申請の受理のお願い',
     E'受理がまだの残業申請が {{件数}} 件あります。\n対象：{{内訳}}\n\n下記から内容を確認して受理してください。\n{{リンク}}')
on conflict (event_key, channel) do nothing;

-- 2) 日次 cron（毎日 00:05 UTC = JST 09:05）
--    本人あての実績未報告リマインド（JST 09:00）と5分ずらす。
--    確認者と本人を兼ねる人に、同じ瞬間に2通届くのを避けるため
select cron.schedule(
  'remind-overtime-pending-review-daily',
  '5 0 * * *',
  $$
  select net.http_post(
    url := 'https://xaeynaxctiiyqxjyuzfi.supabase.co/functions/v1/remind-overtime-pending-review',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := jsonb_build_object('triggered_at', now())
  ) as request_id;
  $$
);

-- 登録解除: select cron.unschedule('remind-overtime-pending-review-daily');
-- ジョブ確認: select * from cron.job;
-- 止めたいとき（プッシュだけ）:
--   update notification_settings set enabled=false where event_key='overtime:pending_review' and channel='push';
