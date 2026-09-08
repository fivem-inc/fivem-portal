-- ============================================================
-- 2026-09-09  シフト未調整の休暇を上長に知らせる（毎朝1回）
-- ============================================================
-- 🚨 このファイルを流す前に、Edge Function remind-leave-shift-adjust を deploy しておくこと。
--    先に cron を登録すると、まだ無い関数を呼びに行って毎朝エラーが出る。

-- 既に同じ名前があれば作り直す（二重登録を防ぐ）
select cron.unschedule('remind-leave-shift-adjust-daily')
 where exists (select 1 from cron.job where jobname = 'remind-leave-shift-adjust-daily');

-- 毎日 00:10 UTC = JST 09:10。
-- 🚨 他の毎朝の通知と時刻をずらす（09:00 実績未報告／09:05 受理のお願い）。
--    同じ瞬間に何本も届くと、まとめて見落とされる。
select cron.schedule(
  'remind-leave-shift-adjust-daily',
  '10 0 * * *',
  $$
  select net.http_post(
    url := 'https://xaeynaxctiiyqxjyuzfi.supabase.co/functions/v1/remind-leave-shift-adjust',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := jsonb_build_object('triggered_at', now())
  ) as request_id;
  $$
);

-- 登録解除: select cron.unschedule('remind-leave-shift-adjust-daily');
-- ジョブ確認: select jobname, schedule, active from cron.job where jobname like 'remind-leave%';
