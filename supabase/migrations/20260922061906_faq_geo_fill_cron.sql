-- お客様向けFAQの記録に「都道府県」を入れる夜間の処理（2026-09-22 ユーザー承認）
--
-- Edge Function `faq-geo-fill` を毎晩1回呼ぶだけ。中身の説明はその関数の先頭に書いてある。
--
-- 【なぜ夜にまとめて引くのか】
--   🚨 記録するその場で引くと、お客様がFAQを開くたびに外部と通信することになり画面が遅くなる。
--      都道府県を見るのは社内の集計だけなので、その晩のうちに入っていれば足りる。
--
-- 【枠】
--   🚨 GeoLite2 の無料枠は1日1,000件。同じIPは1回しか引かない作りにしてある
--      （実測：記録22件に対して別々のIPは11種類）。1回の実行で引くIPは200件まで。
--
-- 【引けなかったとき】
--   🚨 関数が '不明' を入れて二度と引かない。空のままだと毎晩ずっと引き直して枠を無駄にする。
--      集計では「未調査（まだ引いていない）」と「不明（引いたが分からなかった）」が見分けられる。
--
-- 🚨 時刻は 19:20 UTC＝**4:20 JST**。既存の FAQ の掃除（3:50・3:55 JST）とぶつけていない。

select cron.unschedule('faq-geo-fill-daily')
 where exists (select 1 from cron.job where jobname = 'faq-geo-fill-daily');

select cron.schedule(
  'faq-geo-fill-daily',
  '20 19 * * *',          -- 4:20 JST
  $cron$
  select net.http_post(
    url := 'https://xaeynaxctiiyqxjyuzfi.supabase.co/functions/v1/faq-geo-fill',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := jsonb_build_object('triggered_at', now())
  ) as request_id;
  $cron$
);

-- 戻し版（この migration を取り消すとき）:
--   select cron.unschedule('faq-geo-fill-daily');
