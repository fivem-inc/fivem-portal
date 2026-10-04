-- ============================================================
-- 2026-10-04  ログイン用のアドレス（auth.users.email）が変わったら、スタッフの名簿（profiles.email）も同じにする
-- ============================================================
-- ✅ ユーザー確定（2026-10-04・案A）
-- 困っていたこと：本人が「アカウント設定 → メールアドレス変更」で変えると auth.users.email だけが変わり、
--   profiles.email は古いまま残っていた。パスワード設定のメール（password-setup-mail・［はじめての方］）は
--   profiles.email で人を探すので、新しいアドレスを入れても届かなくなる
-- ・2026-10-04 の時点で食い違っている人は0人（実測）。なので今ある行は直さない
-- ・管理者が変えるとき（staff-onboard の update）は、両方を同時に書いている。このトリガーは本人が変えたときの網

create or replace function public.sync_profile_email_from_auth()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if new.email is distinct from old.email and new.email is not null then
    update public.profiles set email = new.email where id = new.id and email is distinct from new.email;
  end if;
  return new;
end;
$function$;

revoke execute on function public.sync_profile_email_from_auth() from public;
revoke execute on function public.sync_profile_email_from_auth() from anon;
revoke execute on function public.sync_profile_email_from_auth() from authenticated;

drop trigger if exists on_auth_user_email_changed on auth.users;
create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute function public.sync_profile_email_from_auth();

comment on function public.sync_profile_email_from_auth() is
  'auth.users.email が変わったら profiles.email も同じにする（本人のメールアドレス変更で名簿が古いまま残らないように・2026-10-04）';
