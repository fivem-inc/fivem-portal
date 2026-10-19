-- 有休奨励日の休みを Google カレンダーに出す：設定の初期値と毎晩の作り直し（2026-10-19・計画 docs/計画-有休奨励日のカレンダー.md）
--
-- ・app_settings 'gcal_encouragement'：{ mode: off|summary|each, types: [有休,調整休,その他], names: bool }
--   初期値は まとめて1件・全部・名前あり（ユーザー確定）。管理画面 → 通知設定 →「有休奨励日の休みの出し方」で変える
-- ・cron gcal-sync-nightly（毎晩 3:50 JST＝18:50 UTC）：共用の Edge Function gcal-sync の action 'nightly'
--   ① これからの奨励日の予定を、今の記録と設定どおりにそろえる（差分だけ。変わりの無い日は Google をほぼ呼ばない）
--   ② これからの日付の休暇・残業の予定のうち、もとの行が無いもの（休暇は取消・差し戻しなど・その日を含まないものも。受理の途中の manager_approved・admin_approved は消さない）を消す（2026-10-19 ユーザー確定）
-- ・呼ぶ鍵は vault の service_role_key（ほかの cron と同じ）
-- 戻すとき：select cron.unschedule('gcal-sync-nightly'); delete from app_settings where key='gcal_encouragement';

insert into public.app_settings (key, value, updated_at)
values ('gcal_encouragement', '{"mode":"summary","types":["有休","調整休","その他"],"names":true}'::jsonb, now())
on conflict (key) do nothing;

select cron.unschedule('gcal-sync-nightly') where exists (select 1 from cron.job where jobname = 'gcal-sync-nightly');
select cron.schedule('gcal-sync-nightly', '50 18 * * *', $cron$
  select net.http_post(
    url := 'https://xaeynaxctiiyqxjyuzfi.supabase.co/functions/v1/gcal-sync',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
    body := jsonb_build_object('action', 'nightly'),
    timeout_milliseconds := 60000
  ) as request_id;
$cron$);
