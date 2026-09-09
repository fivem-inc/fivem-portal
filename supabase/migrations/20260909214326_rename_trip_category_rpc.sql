-- 出張の「区分」の名前変更を、1トランザクションでまとめて行う関数。
--
-- 【なぜ要るか（2026-09-09）】
-- 区分の名前を変えるとき、画面側で2文に分けて書いていた：
--     update master_options set value = 新       where id = ...;                        -- 区分そのもの
--     update master_options set category = 'trip_location_新' where category = 'trip_location_旧';  -- その区分の場所リスト
-- 🚨 どちらも戻り値を見ておらず、1文目だけ成功すると
--    **場所リストが新しい区分から見えなくなる**（出張報告で行き先が選べない）。
--    しかも旧名がもう無いので、**もう一度押しても直らない**。
--
-- → 関数の中は1トランザクションなので、途中で失敗すれば両方とも元のまま。
--
-- 🚨 **この関数に権限判定を書かない**（security definer にしない）。
--    呼び出した人の権限でそのまま動くので、master_options の RLS
--    （管理者だけが update できる）がそのまま効く。
--    自分で権限判定を書くと、2026-09-09 に7本見つかったような
--    「NULL になって素通りする」穴を作ることになる。判定は1か所（RLS）に任せる。

create or replace function public.rename_trip_category(
  p_id       uuid,
  p_old_name text,
  p_new_name text
) returns integer   -- 所属を付け替えた場所の件数を返す
language plpgsql
-- security definer を付けない（＝呼び出した人の権限で動く）
set search_path to 'public'
as $function$
declare
  v_new text := btrim(coalesce(p_new_name, ''));
  v_old text := btrim(coalesce(p_old_name, ''));
  v_cat_count integer;
  v_loc_count integer;
begin
  if v_new = '' then
    raise exception '区分名を入力してください' using errcode = '22023';
  end if;
  if v_new = v_old then
    return 0;   -- 変わっていないので何もしない
  end if;

  update master_options set value = v_new where id = p_id and category = 'trip_category';
  get diagnostics v_cat_count = row_count;

  -- 🚨 0件なら権限が無いか対象が消えている。例外を投げてトランザクションごと戻す
  --   （ここで戻さないと、次の update だけが通って食い違う）
  if v_cat_count = 0 then
    raise exception '区分の名前を変更できませんでした（権限が不足しているか、すでに削除されています）'
      using errcode = '42501';
  end if;

  update master_options
     set category = 'trip_location_' || v_new
   where category = 'trip_location_' || v_old;
  get diagnostics v_loc_count = row_count;

  return v_loc_count;
end;
$function$;

-- 🚨 anon（ログインしていない人）の実行権限を外す。
--    anon だけ名指ししても外れない（anon は PUBLIC の一員）。public と両方から外す。
--    ※ この関数は security definer ではないので、仮に呼ばれても RLS で0件になり
--      上の例外で止まるが、呼べること自体を残す理由が無い。
revoke execute on function public.rename_trip_category(uuid, text, text) from public, anon;
grant  execute on function public.rename_trip_category(uuid, text, text) to authenticated;

comment on function public.rename_trip_category(uuid, text, text) is
  '出張の区分名を変更し、その区分に属する場所リストの所属も1トランザクションで付け替える。戻り値は付け替えた場所の件数。権限は master_options の RLS に従う（2026-09-09 追加）';
