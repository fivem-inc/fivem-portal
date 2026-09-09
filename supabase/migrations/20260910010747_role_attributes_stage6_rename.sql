-- 役職の属性化・段6（改名を「表示名だけを変える操作」にする）。
--
-- 【やること】
-- 1) rename_role が、役職名を持っている残りの場所もまとめて書き換える（1トランザクション）：
--      faq_answer_targets.role_title ／ overtime_threshold_rules.role_title ／ overtime_calendar_choice_rules.role_title
--      （いずれも段5で role_id を持ち、照合は role_id。role_title は表示用）
--      notification_settings.recipient（JSON の roles / ccRoles / orgWideRoles の中の役職名）
--    🚨 判定・宛先解決はすでに属性／role_id で行うので、名前が残っていても壊れないが、
--       画面の表示（管理画面の一覧・宛先のチェック）に古い名前が残るのを防ぐ。
-- 2) master_options の役職一覧（category='role_title'）を廃止する。
--    roles と二重管理になっていて、改名時に追随せず「⚠️ 未登録の値」が出た（2026-09-09）。
--    画面（UsersTab）は roles を読む形にした。
--
-- 🚨 本番の実定義（20260909205739 で置いた版）から起こしている。引数・戻り値は変えていない。

-- JSON 文字列の中の配列（roles / ccRoles / orgWideRoles）にある役職名を置き換える。
-- 旧形式（JSON でないプレーン文字列）はそのまま返す。
create or replace function public.rename_role_in_recipient(p_recipient text, p_old text, p_new text)
returns text language plpgsql immutable as $$
declare
  j jsonb;
  k text;
begin
  if p_recipient is null then return null; end if;
  begin
    j := p_recipient::jsonb;
  exception when others then
    return p_recipient;   -- 旧形式（プレーン文字列）は触らない
  end;
  if jsonb_typeof(j) <> 'object' then return p_recipient; end if;
  foreach k in array array['roles', 'ccRoles', 'orgWideRoles'] loop
    if j ? k and jsonb_typeof(j -> k) = 'array' then
      j := jsonb_set(j, array[k],
             coalesce((select jsonb_agg(case when x = to_jsonb(p_old) then to_jsonb(p_new) else x end)
                         from jsonb_array_elements(j -> k) x), '[]'::jsonb));
    end if;
  end loop;
  return j::text;
end $$;
revoke execute on function public.rename_role_in_recipient(text, text, text) from public;
revoke execute on function public.rename_role_in_recipient(text, text, text) from anon;
grant  execute on function public.rename_role_in_recipient(text, text, text) to authenticated;

create or replace function public.rename_role(p_role_id uuid, p_new_name text)
returns integer   -- role_title を書き換えた人数を返す
language plpgsql security definer set search_path = public as $function$
declare
  v_old_name text;
  v_new_name text := btrim(coalesce(p_new_name, ''));
  v_count    integer;
begin
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
  -- 役職名は一意（profiles.role_title から role_id を導出するため）
  if exists (select 1 from roles r where r.name = v_new_name and r.id <> p_role_id) then
    raise exception '同じ名前の役職がすでにあります' using errcode = '23505';
  end if;
  if v_old_name = v_new_name then
    return 0;
  end if;

  update roles set name = v_new_name where id = p_role_id;

  -- スタッフ（role_title が正。トリガーが role_id を導出するが、ここでは両方そろえて書く）
  update profiles
     set role_title = v_new_name,
         role_id    = p_role_id
   where role_title = v_old_name
      or role_id = p_role_id;
  get diagnostics v_count = row_count;

  -- 役職名を表示用に持っているデータ（照合は role_id・段5）
  update faq_answer_targets          set role_title = v_new_name where role_id = p_role_id;
  update overtime_threshold_rules    set role_title = v_new_name where role_id = p_role_id;
  update overtime_calendar_choice_rules set role_title = v_new_name where role_id = p_role_id;

  -- 通知設定の JSON の中の役職名（読む側は名前でも role_id でも解釈できるが、表示が古い名前で残らないように）
  update notification_settings
     set recipient = rename_role_in_recipient(recipient, v_old_name, v_new_name)
   where recipient like '%' || v_old_name || '%';

  return v_count;
end;
$function$;

revoke execute on function public.rename_role(uuid, text) from public;
revoke execute on function public.rename_role(uuid, text) from anon;
grant  execute on function public.rename_role(uuid, text) to authenticated;

comment on function public.rename_role(uuid, text) is
  '役職名を変更する。表示名を持つ場所（profiles / faq_answer_targets / overtime_*_rules / notification_settings の JSON）を1トランザクションでそろえる。判定は属性・role_id なので改名で権限は変わらない（2026-09-10 段6）';

-- master_options の役職一覧を廃止（roles が唯一の一覧）
delete from public.master_options where category = 'role_title';
