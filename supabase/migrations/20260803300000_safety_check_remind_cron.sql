-- ========================================
-- 安否確認 Phase 3：自動リマインド
--   claim_safety_check_reminders：atomicにリマインド対象をclaimするRPC
--   （UPDATE ... RETURNING で「次回リマインド時刻を過ぎた進行中のcheck」を
--   一度に取得しつつ remind_count を進める。cronの多重起動でも二重送信されない）
-- ========================================

create or replace function claim_safety_check_reminders(p_now timestamptz)
returns table(id uuid)
language sql
security definer
set search_path = public
as $$
  update safety_checks
     set remind_count = remind_count + 1,
         next_remind_at = case
           when remind_count + 1 >= remind_max then null
           else p_now + make_interval(mins => remind_interval_min)
         end
   where status = 'active'
     and cancelled = false
     and next_remind_at is not null
     and next_remind_at <= p_now
     and remind_count < remind_max
  returning safety_checks.id;
$$;

-- サーバー間呼び出し専用（Edge Functionがservice_roleで呼ぶ）。一般ユーザーには実行権限を渡さない。
revoke all on function claim_safety_check_reminders(timestamptz) from public, authenticated;

-- cron登録（5分毎。既存の忘れん坊通知系と同じVaultのservice_role_key・pg_netパターン）
-- 前提：pg_net拡張が有効・vault.decrypted_secretsにservice_role_keyが登録済み（既存クロンで確認済み）
select cron.schedule(
  'safety-check-remind-every-5-min',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://xaeynaxctiiyqxjyuzfi.supabase.co/functions/v1/safety-check-remind',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := jsonb_build_object('triggered_at', now())
  ) as request_id;
  $$
);

-- 登録解除する場合: select cron.unschedule('safety-check-remind-every-5-min');
-- 確認: select * from cron.job where jobname = 'safety-check-remind-every-5-min';
