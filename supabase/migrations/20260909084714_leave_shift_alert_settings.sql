-- ============================================================
-- 2026-09-09  シフト未調整のお知らせを、管理画面から設定できるようにする
-- ============================================================
-- きっかけ：送る時刻（JST 9:10）と時期（3ヶ月前・1ヶ月前）が Edge Function と cron に
-- 直接書かれており、変えるたびに開発者の作業が要る状態だった（ユーザー指示）。
--
-- 設定できるようにするもの：
--   ・送るかどうか（止められる）
--   ・時期（何ヶ月前に送るか。複数指定可）
--   ・送る時刻（JST）
--   ・宛先 … これは既に notification_settings（leave:shift_adjust_due）の recipient で
--            役職・グループ絞りを指定できる。ここには持たない（同じ設定を2か所に置かない）。

create table if not exists leave_shift_alert_settings (
  id            int primary key default 1,
  -- 送るかどうか。false なら毎朝の処理は何もしない
  enabled       boolean not null default true,
  -- 何ヶ月前に送るか。既定は3ヶ月前と1ヶ月前（2026-09-09 ユーザー確定）
  -- 🚨 大きい順に持つ必要はない（関数側で並べ替える）。0や負の数は入れない
  months_before int[] not null default '{3,1}',
  -- 送る時刻（JST）。cron は15分おきに動き、この時刻を過ぎた最初の回で送る
  send_time     time not null default '09:10',
  -- 送る時間帯の幅（分）。この幅を過ぎたら、その日はもう送らない。
  -- 🚨 幅を設けないと、昼すぎに受理された休暇が夕方に通知されることになる。
  --    「朝のうちに届く」を守るための上限
  window_minutes int not null default 120,
  updated_at    timestamptz not null default now(),
  constraint leave_shift_alert_settings_single check (id = 1)
);

insert into leave_shift_alert_settings (id) values (1) on conflict (id) do nothing;

comment on table leave_shift_alert_settings is
  'シフト未調整のお知らせ（毎朝）の設定。宛先は notification_settings の leave:shift_adjust_due 側で指定する';

alter table leave_shift_alert_settings enable row level security;

-- 読みは全員（画面で「いつ送られるか」を出せるように）、書きは管理者だけ
drop policy if exists lsas_select on leave_shift_alert_settings;
create policy lsas_select on leave_shift_alert_settings for select to authenticated using (true);

drop policy if exists lsas_update on leave_shift_alert_settings;
create policy lsas_update on leave_shift_alert_settings for update to authenticated
  using (coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false))
  with check (coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false));

-- ------------------------------------------------------------
-- cron を15分おきに変える
-- ------------------------------------------------------------
-- 🚨 これまで「JST 9:10 ちょうど」に1回だけ動かしていたが、それだと時刻を設定にできない。
--    15分おきに動かし、送る時刻を過ぎたかどうかは Edge Function 側で判断する。
--    送った印（shift_alert_*_sent_at）があるので、何度動いても二重には送らない。
select cron.unschedule('remind-leave-shift-adjust-daily')
 where exists (select 1 from cron.job where jobname = 'remind-leave-shift-adjust-daily');

select cron.schedule(
  'remind-leave-shift-adjust-daily',
  '*/15 * * * *',
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
