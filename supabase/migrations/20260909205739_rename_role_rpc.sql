-- 役職名の変更を、1トランザクションでまとめて行う関数。
--
-- 【なぜ要るか（2026-09-09）】
-- これまで画面側で2文に分けて書いていた：
--     update roles    set name = 新 where id = ...;
--     update profiles set role_title = 新 where role_title = 旧;
-- どちらも戻り値を見ていなかったうえ、**2文で1つの意味**なので、
-- 1文目が通って2文目が失敗すると食い違ったまま残る。
--
-- 🚨 これは表示だけの問題ではない。権限は次の順でたどられる（client/src/hooks/useAuth.ts）：
--       profiles.role_title（文字列）→ その名前で roles を引く → feature_permissions
--     つまり profiles.role_title が古い名前のまま残ると、roles に無い名前になり、
--     **その役職の人全員の権限が読めなくなる**（同じ役職の人が全員巻き込まれる）。
--     いまは「読めなければ前回のキャッシュを使う」守りがあるため即座には消えないが、
--     新しい端末やキャッシュのない状態では権限が消える。
--
-- → 関数の中は1トランザクションなので、途中で失敗すれば**両方とも元のまま**になる。
--   食い違いが原理的に起きない形にする。
--
-- 【role_id もあわせて揃える】
-- profiles には role_id（roles への外部キー）と role_title（文字列）の両方があり、
-- 2026-09-09 時点で **50人中26人が食い違っていた**。
-- 🚨 いまは実害がない（権限判定は role_title しか見ていない）が、
--    将来 role_id を使い始めた瞬間に26人の権限が変わる。
--    この関数で名前を変えるときは、対象者の role_id も正しい値に揃えておく。

create or replace function public.rename_role(
  p_role_id  uuid,
  p_new_name text
) returns integer   -- role_title を書き換えた人数を返す
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_old_name text;
  v_new_name text := btrim(coalesce(p_new_name, ''));
  v_count    integer;
begin
  -- 🚨 管理者だけ。is_admin() は coalesce 済みだが、二重に包んでも害はない
  --    （null が返ると not null = null となり if が成立せず素通りするため）
  if not coalesce(is_admin(), false) then
    raise exception 'permission denied: admin only' using errcode = '42501';
  end if;

  if v_new_name = '' then
    raise exception '役職名を入力してください' using errcode = '22023';
  end if;

  select name into v_old_name from roles where id = p_role_id;
  if v_old_name is null then
    raise exception '対象の役職が見つかりません' using errcode = 'P0002';
  end if;

  -- 同じ名前が他にあると、あとで名前から役職を引けなくなる（権限判定が名前で引くため）
  if exists (select 1 from roles r where r.name = v_new_name and r.id <> p_role_id) then
    raise exception '同じ名前の役職がすでにあります' using errcode = '23505';
  end if;

  -- 名前が変わっていないなら何もしない（押し間違いで人数だけ0が返る）
  if v_old_name = v_new_name then
    return 0;
  end if;

  update roles set name = v_new_name where id = p_role_id;

  -- 🚨 role_title と role_id の両方を揃える。
  --    対象は「古い名前を持っている人」と「role_id がこの役職を指している人」の両方。
  --    どちらか片方しか合っていない人（26人いた）も、ここで揃う。
  update profiles
     set role_title = v_new_name,
         role_id    = p_role_id
   where role_title = v_old_name
      or role_id = p_role_id;
  get diagnostics v_count = row_count;

  return v_count;
end;
$function$;

-- 🚨 anon（ログインしていない人）の実行権限を外す。
--    Supabase は新しい関数に自動で権限を付ける。このリポジトリは Public で
--    anon キーは誰でも入手できるため、必ず外す。
--    🚨 anon だけ名指ししても外れない（anon は PUBLIC の一員）。public と両方から外し、
--       authenticated へ付け直す（2026-09-09 に実測して分かった）。
revoke execute on function public.rename_role(uuid, text) from public;
revoke execute on function public.rename_role(uuid, text) from anon;
grant  execute on function public.rename_role(uuid, text) to authenticated;

comment on function public.rename_role(uuid, text) is
  '役職名を変更し、その役職のスタッフの role_title / role_id を1トランザクションで揃える。戻り値は書き換えた人数。管理者のみ実行可（2026-09-09 追加）';
