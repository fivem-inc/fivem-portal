-- 役職の属性化・段4（Edge Function の宛先解決を DB の1か所に寄せるための下地）。
--
-- 【なぜ要るか】
-- Edge Function 7本が「役職名の配列 → profiles を role_title で引く」処理を**それぞれ写し**で持っていて、
-- 既定値（['リーダー','マネージャー'] など）も役職名で直書きされていた。
-- → 宛先の解決は resolve_role_recipients（DB）1本に寄せ、Edge 側は rpc で呼ぶだけにする
--   （remind-leave-shift-adjust が 2026-09-09 からこの形。それを全体に広げる）。
--
-- 【この migration でやること】
-- 1) resolve_role_recipients の roles / orgWideRoles に「立場のコード」（leader/manager/accounting/president）と
--    「属性のコード」（approver/leader_plus/manager_plus/board_approver/org_wide）も書けるようにする。
--    役職名・role_id もこれまでどおり受け付ける（段5で JSON を role_id に変換するまでの両対応）。
--    → Edge 側の既定値を ['leader','manager'] のようにコードで書ける＝役職名を直書きしない。
-- 2) 絞り込みなし版の profile_ids_for_roles(text[]) を足す（purchase-reimbursement-notify / push-dispatch の
--    ccRoles / overtime-grant-request-notify のような「役職の集合 → 人」だけの用途）。
--
-- 🚨 本番の実定義（migration 20260909232945 で置いた版）から起こしている。引数・戻り値は変えていない。

-- 役職の指定（名前・role_id・立場コード・属性コードの混在可）を role_id の配列にする
create or replace function public.role_ids_for(p_spec text[])
returns uuid[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct r.id), '{}'::uuid[])
    from roles r
   where r.name = any(p_spec)
      or r.id::text = any(p_spec)
      or (r.acts_as is not null and r.acts_as = any(p_spec))
      or ('approver'       = any(p_spec) and r.is_approver)
      or ('leader_plus'    = any(p_spec) and r.is_leader_plus)
      or ('manager_plus'   = any(p_spec) and r.is_manager_plus)
      or ('board_approver' = any(p_spec) and r.is_board_approver)
      or ('org_wide'       = any(p_spec) and r.is_org_wide);
$$;
comment on function public.role_ids_for(text[]) is
  '役職の指定（役職名／role_id／立場コード leader,manager,accounting,president／属性コード approver,leader_plus,manager_plus,board_approver,org_wide の混在可）を role_id の配列に解決する（2026-09-10 段4）';

-- 絞り込みなし。その役職集合に属する在籍者の id（除外したい人があれば p_exclude）
create or replace function public.profile_ids_for_roles(p_spec text[], p_exclude uuid default null)
returns setof uuid language sql stable security definer set search_path = public as $$
  select p.id from profiles p
   where p.is_active = true
     and p.role_id = any(role_ids_for(p_spec))
     and (p_exclude is null or p.id <> p_exclude);
$$;
comment on function public.profile_ids_for_roles(text[], uuid) is
  '役職の指定（role_ids_for と同じ書き方）に当てはまる在籍者の id。グループ絞り込みなし（2026-09-10 段4）';

-- 宛先解決：roles / orgWideRoles の指定を role_ids_for で解釈する（名前・id・立場・属性の混在可）
create or replace function public.resolve_role_recipients(p_applicant uuid, p_recipient jsonb)
 returns setof uuid language plpgsql stable security definer set search_path to 'public' as $function$
declare
  v_roles_raw    text[];
  v_owide_raw    text[];
  v_roles        uuid[];
  v_org_wide     uuid[];
  v_group_roles  uuid[];
  v_owide_roles  uuid[];
  v_group_filter text;
  v_teams        text[];
begin
  v_group_filter := coalesce(p_recipient ->> 'groupFilter', 'all');

  -- 宛先の役職。指定が無ければ立場 leader/manager/president の役職すべて
  if p_recipient ? 'roles' then
    v_roles_raw := coalesce((select array_agg(x) from jsonb_array_elements_text(p_recipient -> 'roles') x), '{}');
    v_roles := role_ids_for(v_roles_raw);
  else
    v_roles := role_ids_for(array['leader', 'manager', 'president']);
  end if;

  -- 絞り込みの対象外。指定が無ければ属性「経営」の役職すべて
  if p_recipient ? 'orgWideRoles' then
    v_owide_raw := coalesce((select array_agg(x) from jsonb_array_elements_text(p_recipient -> 'orgWideRoles') x), '{}');
    v_org_wide := role_ids_for(v_owide_raw);
  else
    v_org_wide := role_ids_for(array['org_wide']);
  end if;

  v_group_roles := array(select unnest(v_roles) except select unnest(v_org_wide));
  v_owide_roles := array(select unnest(v_roles) intersect select unnest(v_org_wide));

  select coalesce(array_agg(g), '{}')
    into v_teams
    from unnest(coalesce((select group_names from profiles where id = p_applicant), '{}')) g
   where g in (select value from master_options where category = 'shift_report_group');

  if not exists (select 1 from master_options where category = 'shift_report_group') then
    v_teams := coalesce((select group_names from profiles where id = p_applicant), '{}');
  end if;

  return query
    select p.id from profiles p
     where p.is_active = true
       and p.role_id = any(v_group_roles)
       and (v_group_filter <> 'same' or cardinality(v_teams) = 0 or p.group_names && v_teams)
       and p.id <> p_applicant
    union
    select p.id from profiles p
     where p.is_active = true
       and p.role_id = any(v_owide_roles)
       and p.id <> p_applicant;
end $function$;

-- 🚨 これらは Edge Function（service_role）と、画面（authenticated）から呼ぶ。
--    anon から呼べる必要は無いので外す（public と anon の両方から外し、authenticated へ付け直す）
revoke execute on function public.role_ids_for(text[]) from public;
revoke execute on function public.role_ids_for(text[]) from anon;
grant  execute on function public.role_ids_for(text[]) to authenticated, service_role;
revoke execute on function public.profile_ids_for_roles(text[], uuid) from public;
revoke execute on function public.profile_ids_for_roles(text[], uuid) from anon;
grant  execute on function public.profile_ids_for_roles(text[], uuid) to authenticated, service_role;
