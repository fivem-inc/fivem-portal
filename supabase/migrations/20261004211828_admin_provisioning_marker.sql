-- ============================================================
-- 2026-10-04  管理者が作ったアカウントで「新規登録」の通知を飛ばさない（直し）
-- ============================================================
-- 🚨 20261004155931 では app_metadata の provisioned_by_admin を見ていたが、本番で試すと通知が飛んだ
--    （auth.admin.createUser は、行を作った瞬間の raw_app_meta_data にまだ印を入れていない。名前の user_metadata は入っている）。
--    試しの1件（「試験 入社予定」・仮のアドレス）で経理にベル1件と Slack が飛んだ。ベルは消した
-- 直し方：Edge Function（staff-onboard / create-user）がアカウントを作る**直前**に、そのアドレスをこの表に書く。
--   トリガーは表にあれば通知を飛ばさず、その行を消す（1回きり）。
--   🚨 この表は本人からは読めも書けもしない（RLS を有効にしてポリシー無し・anon / authenticated から権限を外す）。
--      user_metadata（本人が signUp で書ける）に印を置く形にしないのはこのため
-- 🚨 handle_new_user は直前の 20261004155931 の版から起こした（本番の実定義と同じことを確かめてから）

create table if not exists public.admin_provisioning_emails (
  email      text primary key,
  created_at timestamptz not null default now()
);
alter table public.admin_provisioning_emails enable row level security;
revoke all on public.admin_provisioning_emails from anon;
revoke all on public.admin_provisioning_emails from authenticated;
comment on table public.admin_provisioning_emails is
  '管理者がこれから作るアカウントのアドレス（小文字）。handle_new_user が見て「新規登録」の通知を止め、行を消す。書くのは staff-onboard / create-user だけ（2026-10-04）';

create or replace function public.handle_new_user()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_by_admin boolean;
begin
  insert into public.profiles (id, email, name, is_active, approval_status)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'full_name'),
          false, 'pending');

  -- 管理者が作ったアカウントか（控えの表にあれば、その行を消して true）
  delete from public.admin_provisioning_emails where email = lower(new.email);
  v_by_admin := found or coalesce(new.raw_app_meta_data->>'provisioned_by_admin', '') = 'true';

  if not v_by_admin then
    perform net.http_post(
      url := 'https://xaeynaxctiiyqxjyuzfi.supabase.co/functions/v1/new-signup-notify',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
      ),
      body := jsonb_build_object('email', new.email,
                                 'name', coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'full_name'))
    );
  end if;

  return new;
end;
$function$;

-- 作るのに失敗して残った控え（1日より古いもの）を毎晩消す。🚨 記録を貯める表には掃除を必ず付ける
select cron.unschedule('purge-admin-provisioning-emails') where exists (select 1 from cron.job where jobname = 'purge-admin-provisioning-emails');
select cron.schedule('purge-admin-provisioning-emails', '20 18 * * *',
  $$delete from public.admin_provisioning_emails where created_at < now() - interval '1 day';$$);
