-- 新規登録（SignIn.tsxの自己登録フォーム）を承認制にする
-- 既存ユーザーは approval_status='approved' のまま影響なし

alter table public.profiles
  add column if not exists approval_status text not null default 'approved';

-- 既存データは念のため全員 approved にしておく（defaultだけでは過去行に効かないため）
update public.profiles set approval_status = 'approved' where approval_status is null;

-- 新規登録時のトリガーを更新：承認待ち状態で作成し、通知Edge Functionを呼び出す
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email, name, is_active, approval_status)
  values (new.id, new.email, new.raw_user_meta_data->>'name', false, 'pending');

  perform net.http_post(
    url := 'https://xaeynaxctiiyqxjyuzfi.supabase.co/functions/v1/new-signup-notify',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := jsonb_build_object('email', new.email, 'name', new.raw_user_meta_data->>'name')
  );

  return new;
end;
$$ language plpgsql security definer;
