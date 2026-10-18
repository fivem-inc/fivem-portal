-- 毎分のスマホ通知の送信係（cron push-dispatch-every-min）を、送るものがあるときだけ呼ぶ（2026-10-18・通信量の見直し）
-- ・今までは送るものが無くても毎分 Edge Function push-dispatch を呼び、そのたびに DB を5本読み書きしていた（1日 約7,200本）
-- ・push-dispatch が見ている入力は2つだけ（supabase/functions/push-dispatch/index.ts）：
--     push_queue.status='pending'（再試行中・受信時間外で保留中も含む）／push_deferred.status='pending'（受信時間外に保留した直送）
--   🚨 どちらか一方でも pending があれば呼ぶ（push_deferred を落とすと、受信時間外に保留した通知が届かなくなる）
-- ・Edge Function の中身は変えない（2人共用）。schedule（毎分）も変えない
-- ・副作用：7日より古い行の掃除は、送るものがある回にしか動かない（毎日送信があるので実害なし）
-- ・戻すときは、下の「戻す command」をそのまま cron.alter_job に入れる（2026-10-18 時点の本番の command と同じ）
--
-- 戻す command（2026-10-18 の本番の実物）：
--   select net.http_post(
--     url := 'https://xaeynaxctiiyqxjyuzfi.supabase.co/functions/v1/push-dispatch',
--     headers := jsonb_build_object(
--       'Content-Type', 'application/json',
--       'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
--     ),
--     body := jsonb_build_object('triggered_at', now())
--   ) as request_id;

select cron.alter_job(
  (select jobid from cron.job where jobname = 'push-dispatch-every-min'),
  command := $cmd$
  select net.http_post(
    url := 'https://xaeynaxctiiyqxjyuzfi.supabase.co/functions/v1/push-dispatch',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := jsonb_build_object('triggered_at', now())
  ) as request_id
  where exists (select 1 from public.push_queue where status = 'pending')
     or exists (select 1 from public.push_deferred where status = 'pending');
$cmd$
);
