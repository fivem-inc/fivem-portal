-- 管理画面をマネージャー以上に開く（① 入口）2026-09-15
-- 設計・決めたことは docs/計画-管理画面の開放.md（4・6-2・6-2b・6-3）。
--
-- ・app_settings 'manager_admin_tabs'＝マネージャー以上に開くタブの配列。最初は空＝全部オフ
-- ・can_manage_admin_tab(タブ)＝管理者、または（マネージャー以上 かつ そのタブが開いている）
--   🚨 各タブの書き込みの決まりをこれで広げる＝管理者がチェックを外せば DB の書き込みも止まる
--   🚨 「パソコンだけ」は画面の制限。DB は端末を見分けられない
--   🚨 安否・緊急は例外：締め・取消・発信はもともと is_manager_plus() で、ここでは触らない
-- ・お知らせ：書き込みを広げる／notified_at（作成時の通知を送った印）／作成者と送信済みの印は管理者以外は変えられない
-- ・グループ：所属を1つ足す・外す関数（相手が管理者・全社の役職・自分より上なら断る）
-- ・リマインド：書き込みを広げる／作るときの作成者は自分／対応状況の関数／チャンネル一覧の関数
-- ・FAQ：can_edit_faq() に can_manage_admin_tab('faq') を足す（本番の実定義から起こした）

-- ───────────────────────────────────────────
-- 1. 設定の行（空＝全部オフ）
-- ───────────────────────────────────────────
insert into public.app_settings (key, value)
values ('manager_admin_tabs', '[]'::jsonb)
on conflict (key) do nothing;

-- ───────────────────────────────────────────
-- 2. 判定の関数
-- ───────────────────────────────────────────
-- board_can_manage_groups() と同じ形。🚨 配列でない値（null・文字列）は開いていない扱い
create or replace function public.can_manage_admin_tab(p_tab text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_admin()
      or (
           p_tab is not null
           and public.is_manager_plus()
           and exists (
                 select 1
                 from public.app_settings s
                 cross join lateral jsonb_array_elements_text(
                   case when jsonb_typeof(s.value) = 'array' then s.value else '[]'::jsonb end
                 ) as v(tab)
                 where s.key = 'manager_admin_tabs'
                   and v.tab = p_tab
               )
         );
$$;

comment on function public.can_manage_admin_tab(text) is
  '管理者、またはマネージャー以上で app_settings.manager_admin_tabs にそのタブが入っているとき true。管理画面をマネージャー以上に開く（2026-09-15）';

revoke execute on function public.can_manage_admin_tab(text) from public;
revoke execute on function public.can_manage_admin_tab(text) from anon;
grant execute on function public.can_manage_admin_tab(text) to authenticated;

-- ───────────────────────────────────────────
-- 3. お知らせ
-- ───────────────────────────────────────────
alter table public.announcements add column if not exists notified_at timestamptz;

comment on column public.announcements.notified_at is
  '作成時の通知（announcement-notify）を送った日時。null の行だけ送る＝二重送信の歯止め。管理者以外は変えられない';

-- 🚨 いまある行は「送り済み」にしておく（あとから古いお知らせに作成時の通知を飛ばせないように）
update public.announcements set notified_at = created_at where notified_at is null;

-- 作成者・送信済みの印（作成時の通知／期限前のリマインド）は管理者以外は変えられない。
-- 🚨 SECURITY DEFINER にしない：current_user で「画面からの操作（authenticated）」を見分けるため。
--    Edge Function（service_role）と SQL の直接操作はそのまま通す
create or replace function public.announcements_guard_system_columns()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user <> 'authenticated' or public.is_admin() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.created_by is distinct from auth.uid() then
      raise exception 'お知らせの作成者は自分にしてください' using errcode = '42501';
    end if;
    if new.notified_at is not null or new.remind_last_sent_on is not null then
      raise exception '送信済みの印は付けられません' using errcode = '42501';
    end if;
  else
    if new.created_by is distinct from old.created_by
       or new.notified_at is distinct from old.notified_at
       or new.remind_last_sent_on is distinct from old.remind_last_sent_on then
      raise exception 'お知らせの作成者と送信済みの印は、管理者しか変えられません' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.announcements_guard_system_columns() from public;
revoke execute on function public.announcements_guard_system_columns() from anon;

drop trigger if exists trg_announcements_guard_system_columns on public.announcements;
create trigger trg_announcements_guard_system_columns
  before insert or update on public.announcements
  for each row execute function public.announcements_guard_system_columns();

-- 書き込み：管理者 → 管理者 or お知らせのタブが開いているマネージャー以上。🚨 名前は変えない
drop policy if exists announcements_admin_write on public.announcements;
create policy announcements_admin_write on public.announcements
  for all to authenticated
  using ((select public.can_manage_admin_tab('announcements')))
  with check ((select public.can_manage_admin_tab('announcements')));

-- ───────────────────────────────────────────
-- 4. グループ（所属を1つ足す・外す）
-- ───────────────────────────────────────────
-- 🚨 group_names のその1つだけを1文で足す／外す（役職・雇用形態など他の列は触らない）
-- 🚨 所属チーム（こども・大人・管理部）も扱う＝休暇・残業の受理依頼が届く上長が変わる（2026-09-14 ユーザー確定）
-- 🚨 管理者以外は、相手が管理者・全社の役職・自分より上の役職なら断る
-- 戻り値：変えたあとの group_names（すでにその状態なら、いまの値）
create or replace function public.set_profile_group(p_user_id uuid, p_group text, p_member boolean)
returns text[]
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_my_rank integer;
  v_target_name text;
  v_target_rank integer;
  v_target_org_wide boolean;
  v_target_is_admin boolean;
  v_result text[];
begin
  if not public.can_manage_admin_tab('groups') then
    raise exception '所属を変える権限がありません' using errcode = '42501';
  end if;
  if p_user_id is null or p_group is null or p_member is null then
    raise exception '指定が足りません' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.master_options mo
    where mo.category in ('group', 'shift_report_group') and mo.value = p_group
  ) then
    raise exception '「%」というグループはありません', p_group using errcode = '22023';
  end if;

  select p.name, r.sort_order, coalesce(r.is_org_wide, false),
         coalesce(u.raw_app_meta_data ->> 'role', '') = 'admin'
    into v_target_name, v_target_rank, v_target_org_wide, v_target_is_admin
    from public.profiles p
    left join public.roles r on r.id = p.role_id
    left join auth.users u on u.id = p.id
   where p.id = p_user_id;
  if not found then
    raise exception 'スタッフが見つかりません' using errcode = 'P0002';
  end if;

  if not public.is_admin() then
    if v_target_is_admin or v_target_org_wide then
      raise exception '%さんの所属は管理者しか変えられません', coalesce(v_target_name, '') using errcode = '42501';
    end if;
    select r.sort_order into v_my_rank
      from public.profiles p join public.roles r on r.id = p.role_id
     where p.id = auth.uid();
    if v_my_rank is null or coalesce(v_target_rank, 0) > v_my_rank then
      raise exception '%さんはご自身より上の役職のため、所属を変えられません', coalesce(v_target_name, '') using errcode = '42501';
    end if;
  end if;

  if p_member then
    update public.profiles
       set group_names = array_append(coalesce(group_names, '{}'::text[]), p_group)
     where id = p_user_id
       and not (coalesce(group_names, '{}'::text[]) @> array[p_group])
    returning group_names into v_result;
  else
    update public.profiles
       set group_names = array_remove(group_names, p_group)
     where id = p_user_id
       and coalesce(group_names, '{}'::text[]) @> array[p_group]
    returning group_names into v_result;
  end if;

  -- 二度押し・他の人が先に同じ操作をした＝すでにその状態。いまの値を返す
  if not found then
    select coalesce(p.group_names, '{}'::text[]) into v_result from public.profiles p where p.id = p_user_id;
  end if;
  return v_result;
end;
$$;

comment on function public.set_profile_group(uuid, text, boolean) is
  'スタッフの所属（group_names）を1つ足す・外す。can_manage_admin_tab(''groups'')。管理者以外は管理者・全社の役職・自分より上の役職を断る（2026-09-15）';

revoke execute on function public.set_profile_group(uuid, text, boolean) from public;
revoke execute on function public.set_profile_group(uuid, text, boolean) from anon;
grant execute on function public.set_profile_group(uuid, text, boolean) to authenticated;

-- ───────────────────────────────────────────
-- 5. リマインド設定
-- ───────────────────────────────────────────
-- 書き込み：管理者 → 管理者 or リマインド設定のタブが開いているマネージャー以上。🚨 名前は変えない
drop policy if exists reminders_admin_write on public.board_scheduled_reminders;
create policy reminders_admin_write on public.board_scheduled_reminders
  for all to authenticated
  using ((select public.can_manage_admin_tab('scheduled_reminders')))
  with check ((select public.can_manage_admin_tab('scheduled_reminders')));

-- 作るときの作成者は自分（他の人の名前で作らせない）。制限の決まりなので上と AND で効く
drop policy if exists reminders_insert_own_creator on public.board_scheduled_reminders;
create policy reminders_insert_own_creator on public.board_scheduled_reminders
  as restrictive
  for insert to authenticated
  with check (created_by = (select auth.uid()));

-- 送るタイミング（有給奨励日・連絡板の締切未読）も同じタブで開く（2026-09-14 ユーザー確定「両方開く」）
drop policy if exists "管理者のみ編集可" on public.reminder_days_settings;
create policy "管理者のみ編集可" on public.reminder_days_settings
  for all to authenticated
  using ((select public.can_manage_admin_tab('scheduled_reminders')))
  with check ((select public.can_manage_admin_tab('scheduled_reminders')));

-- 対応状況：本番の実定義から起こし、権限の判定だけを差し替えた
create or replace function public.scheduled_reminder_status(p_reminder_id uuid, p_dates integer DEFAULT 3, p_names integer DEFAULT 10)
 RETURNS TABLE(delivered_on date, target_count integer, done_count integer, pending_count integer, pending_names text[])
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if not public.can_manage_admin_tab('scheduled_reminders') then
    raise exception '権限がありません';
  end if;

  return query
  with target_dates as (
    select r.delivered_on as d
    from public.scheduled_reminder_responses r
    where r.reminder_id = p_reminder_id
    group by r.delivered_on
    order by r.delivered_on desc
    limit greatest(p_dates, 1)
  )
  select
    t.d,
    count(*)::int,
    count(*) filter (where r.status = 'done')::int,
    count(*) filter (where r.status <> 'done')::int,
    coalesce(
      (array_agg(coalesce(p.name, '(不明)') order by p.name)
         filter (where r.status <> 'done'))[1:greatest(p_names, 1)],
      '{}'::text[]
    )
  from target_dates t
  join public.scheduled_reminder_responses r
    on r.reminder_id = p_reminder_id and r.delivered_on = t.d
  left join public.profiles p on p.id = r.user_id
  group by t.d
  order by t.d desc;
end;
$function$;

-- 送り先に選べるチャンネルの一覧（id と名前だけ）。
-- 🚨 board_channels の読みは「メンバー／作成者／管理者」だけなので、マネージャーは自分が入っていないチャンネルを選べなかった
create or replace function public.reminder_channel_options()
returns table (id uuid, name text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.can_manage_admin_tab('scheduled_reminders') then
    raise exception '権限がありません' using errcode = '42501';
  end if;
  return query
    select c.id, c.name from public.board_channels c order by c.name;
end;
$$;

comment on function public.reminder_channel_options() is
  'リマインド設定の送り先に選べる連絡板のチャンネル（id と名前だけ）。can_manage_admin_tab(''scheduled_reminders'')（2026-09-15）';

revoke execute on function public.reminder_channel_options() from public;
revoke execute on function public.reminder_channel_options() from anon;
grant execute on function public.reminder_channel_options() to authenticated;

-- ───────────────────────────────────────────
-- 6. FAQ（本番の実定義から起こし、最後の1行だけ足した）
-- ───────────────────────────────────────────
-- 🚨 FAQ の表すべて（topics・answers・targets・relations・public_event・query_log）に効く
CREATE OR REPLACE FUNCTION public.can_edit_faq()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false)
      or exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and p.is_faq_editor = true
      )
      or public.can_manage_admin_tab('faq');
$function$;
