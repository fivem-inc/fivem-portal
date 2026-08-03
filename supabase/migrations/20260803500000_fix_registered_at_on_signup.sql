-- ========================================
-- 新規登録（自己サインアップ）で registered_at が入っていなかった不具合の修正
--   管理者が作成したユーザーには入るが、ログイン画面から自分で登録した人は null のままで、
--   管理画面の「承認待ちの新規登録」でいつ来た申請なのか分からなかった（放置に気づけない）。
--   handle_new_user トリガーが registered_at をセットしていなかったのが原因。
--
--   ⚠️ 既存の handle_new_user の中身を壊さないため、関数全体を書き換えるのではなく
--      「profiles に registered_at が入っていなければ auth.users.created_at で埋める」
--      という後追いの独立したトリガーを足す方式にする（他の処理への影響をゼロにするため）。
-- 追加のみ・既存データ無傷。
-- ========================================

create or replace function set_profile_registered_at() returns trigger
language plpgsql security definer set search_path = public
as $$
begin
  if new.registered_at is null then
    new.registered_at := now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_profile_registered_at on public.profiles;
create trigger trg_profile_registered_at
  before insert on public.profiles
  for each row execute function set_profile_registered_at();

-- 既に登録済みで registered_at が空の人を、認証アカウントの作成日時で埋める
-- （自己登録した人＝profiles と auth.users がほぼ同時に作られるため実態と一致する）
update public.profiles p
   set registered_at = u.created_at
  from auth.users u
 where p.id = u.id
   and p.registered_at is null;
