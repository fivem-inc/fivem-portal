-- 申請依頼「期限」リマインドの登録（2026-09-11 ユーザー承認）
--   ① 通知設定の行（管理画面から ON/OFF できるようにするため）
--   ② 毎朝9時（JST）の cron
--
-- 🚨 **通知設定の行を必ず入れる。** 管理画面（通知設定）は
--    `notification_settings` に**行があるチャンネルだけ**を出す作りなので、
--    行が無いと「通知は飛ぶのに管理画面には何も出ない＝止められない」状態になる。
--    ＝画面が嘘をつく形なので、Function と同時に入れる。
-- 🚨 送る相手は「その依頼を受けている本人」だけなので recipient は使わない（null）。
--    宛先を解決する仕組みには乗らないため、「設定が無い＝全員に飛ぶ」事故は起きない。
-- 🚨 メールは **既定 false**（ユーザー確定＝ベルとプッシュだけ）。ただし
--    行と文面は用意しておく＝あとから管理画面のトグルだけで出せる。
-- 🚨 二重に入れないため、どちらも「あれば消してから入れる」形にしてある。

-- ① 通知設定
delete from public.notification_settings where event_key = 'application_request:due';

insert into public.notification_settings (event_key, channel, enabled, recipient, subject, template) values
  ('application_request:due', 'site',  true,  null, null, null),
  ('application_request:due', 'push',  true,  null, null, null),
  ('application_request:due', 'email', false, null,
   '申請依頼の期限が近づいています',
   E'申請がまだの依頼が {{件数}} 件あります。\n{{内訳}}\n\n{{リンク}}');

-- ② cron（UTC 00:00 ＝ JST 09:00。他の日次リマインドと同じ時刻に揃えている）
-- 🚨 鍵は vault から取る。SQL にも cron の履歴にも鍵の文字を残さないため
--    （既存の remind-* と同じ形。ここを直書きにすると本番DBに鍵が残る）
select cron.unschedule('remind-application-request-daily')
 where exists (select 1 from cron.job where jobname = 'remind-application-request-daily');

select cron.schedule(
  'remind-application-request-daily',
  '0 0 * * *',
  $job$
  select net.http_post(
    url := 'https://xaeynaxctiiyqxjyuzfi.supabase.co/functions/v1/remind-application-request',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := jsonb_build_object('triggered_at', now())
  ) as request_id;
  $job$
);
