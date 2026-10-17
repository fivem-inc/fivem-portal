-- 入社・退職の手続き：マネージャーも項目を編集できる／全部済んだら「完了しました」のベル（2026-10-17 ユーザー確定・計画 docs/計画-休職と手続き.md）
-- ・項目（hire_checklist_items／retire_checklist_items）の書き込み：追加・変更＝is_manager_plus()／削除＝is_admin() のまま
--   入社の auto_key（初めてのログインで自動で済みになる項目）は管理者だけが足したり変えたりできる
-- ・項目に最終変更の人と日時（updated_by／updated_at）
-- ・全部済んだら、通知設定の宛先（初めはマネージャー・社長・管理者）へベルだけ（event_key を付けない＝スマホには出さない）。済みにした本人には送らない
--   1回だけ：staff_checklist_done_log（種類・人・その時の入社日／退職日）。外して付け直しても、あとで必須が足されてまた済んでも、同じ日付なら送らない（ユーザー確定 A）。
--   退職を取り消して別の日付で登録し直したときは、新しい手続きとしてもう一度送る
-- ・判定はチェックの追加（初めてのログインの自動の済みも含む）と、項目の変更・削除（必須を外す・隠す・削除）の両方から、同じ関数 staff_checklist_done_check で
--   🚨 初めてのログインの自動の済みは auth.users のトリガーの中で書かれる→ここで落ちるとログインが失敗するので、中身をすべて exception で受ける
-- ・🚨 出す前にすでに全部済んでいる人は「送った」ことにしておく（バックフィル）。しないと最初の変更で過去の人の分が一度に届く

begin;

-- ── 1. 項目の書き込みの権限 ──────────────────────────
drop policy if exists hire_checklist_items_write on public.hire_checklist_items;
drop policy if exists hire_checklist_items_insert on public.hire_checklist_items;
drop policy if exists hire_checklist_items_update on public.hire_checklist_items;
drop policy if exists hire_checklist_items_delete on public.hire_checklist_items;
create policy hire_checklist_items_insert on public.hire_checklist_items for insert to authenticated with check (is_manager_plus());
create policy hire_checklist_items_update on public.hire_checklist_items for update to authenticated using (is_manager_plus()) with check (is_manager_plus());
create policy hire_checklist_items_delete on public.hire_checklist_items for delete to authenticated using (is_admin());

drop policy if exists retire_checklist_items_write on public.retire_checklist_items;
drop policy if exists retire_checklist_items_insert on public.retire_checklist_items;
drop policy if exists retire_checklist_items_update on public.retire_checklist_items;
drop policy if exists retire_checklist_items_delete on public.retire_checklist_items;
create policy retire_checklist_items_insert on public.retire_checklist_items for insert to authenticated with check (is_manager_plus());
create policy retire_checklist_items_update on public.retire_checklist_items for update to authenticated using (is_manager_plus()) with check (is_manager_plus());
create policy retire_checklist_items_delete on public.retire_checklist_items for delete to authenticated using (is_admin());

-- ── 2. 最終変更の人と日時・auto_key の守り ──────────────
alter table public.hire_checklist_items   add column if not exists updated_by uuid references public.profiles(id) on delete set null;
alter table public.hire_checklist_items   add column if not exists updated_at timestamptz;
alter table public.retire_checklist_items add column if not exists updated_by uuid references public.profiles(id) on delete set null;
alter table public.retire_checklist_items add column if not exists updated_at timestamptz;

create or replace function public.staff_checklist_item_stamp()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- 入社の auto_key は管理者だけ（マネージャーが「初めてのログイン」の項目の仕組みを書き換えられないように）
  if tg_table_name = 'hire_checklist_items' and auth.uid() is not null and not coalesce(is_admin(), false) then
    if (tg_op = 'INSERT' and new.auto_key is not null)
       or (tg_op = 'UPDATE' and new.auto_key is distinct from old.auto_key) then
      raise exception 'CHECKLIST_AUTO_KEY: 自動で済みになる項目の設定は管理者だけが変えられます' using errcode = '42501';
    end if;
  end if;
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  new.updated_at := now();
  return new;
end;
$function$;
revoke execute on function public.staff_checklist_item_stamp() from public;
revoke execute on function public.staff_checklist_item_stamp() from anon;
revoke execute on function public.staff_checklist_item_stamp() from authenticated;

drop trigger if exists trg_hire_checklist_item_stamp on public.hire_checklist_items;
create trigger trg_hire_checklist_item_stamp before insert or update on public.hire_checklist_items
  for each row execute function public.staff_checklist_item_stamp();
drop trigger if exists trg_retire_checklist_item_stamp on public.retire_checklist_items;
create trigger trg_retire_checklist_item_stamp before insert or update on public.retire_checklist_items
  for each row execute function public.staff_checklist_item_stamp();

-- ── 3. 「送った」記録 ──────────────────────────────
create table if not exists public.staff_checklist_done_log (
  kind        text not null check (kind in ('hire', 'retire')),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  on_date     date not null,   -- その時の入社日／退職日（取り消して別の日付で登録し直したら別の手続き）
  notified_at timestamptz not null default now(),
  primary key (kind, user_id, on_date)
);
alter table public.staff_checklist_done_log enable row level security;
-- 🚨 画面からは読まない・書かない（ポリシーなし＝SECURITY DEFINER の関数だけが触る）
revoke all on public.staff_checklist_done_log from anon, authenticated;
comment on table public.staff_checklist_done_log is '入社・退職の手続きが全部済んだお知らせを送った記録（1つの手続きに1回だけ・2026-10-17）';

-- ── 4. 残りの数え方（lib/retire.ts の retireRemaining と同じ：使っている必須の項目のうち、記録が無いもの）──
create or replace function public.staff_checklist_remaining(p_kind text, p_uid uuid)
returns integer
language sql
stable
security definer
set search_path to 'public'
as $function$
  select case p_kind
    when 'hire' then (select count(*)::int from hire_checklist_items i where i.active and i.required
                       and not exists (select 1 from hire_checklist_checks c where c.user_id = p_uid and c.item_id = i.id))
    when 'retire' then (select count(*)::int from retire_checklist_items i where i.active and i.required
                       and not exists (select 1 from retire_checklist_checks c where c.user_id = p_uid and c.item_id = i.id))
  end;
$function$;
revoke execute on function public.staff_checklist_remaining(text, uuid) from public;
revoke execute on function public.staff_checklist_remaining(text, uuid) from anon;
revoke execute on function public.staff_checklist_remaining(text, uuid) from authenticated;

-- ── 5. 全部済んだかを調べて、初めてならベル ──────────────
create or replace function public.staff_checklist_done_check(p_kind text, p_uid uuid, p_actor uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  p          record;
  v_date     date;
  v_set      record;
  v_ins      integer;
  v_label    text := case p_kind when 'hire' then '入社' else '退職' end;
  v_name     text;
begin
  begin
    select id, name, hire_date, retire_date, retired_at, approval_status into p from profiles where id = p_uid;
    if not found then return; end if;
    -- 手続きの一覧に出る人だけ（lib/staffChecklist の peopleQuery と同じ）
    if p_kind = 'hire' then
      if p.hire_date is null or p.retired_at is not null or p.retire_date is not null or coalesce(p.approval_status, '') = 'pending' then return; end if;
      v_date := p.hire_date;
    elsif p_kind = 'retire' then
      if p.retire_date is null then return; end if;
      v_date := p.retire_date;
    else
      return;
    end if;
    -- 必須の項目が1つも無いときは「済んだ」にしない
    if p_kind = 'hire' and not exists (select 1 from hire_checklist_items where active and required) then return; end if;
    if p_kind = 'retire' and not exists (select 1 from retire_checklist_items where active and required) then return; end if;
    if staff_checklist_remaining(p_kind, p_uid) > 0 then return; end if;

    insert into staff_checklist_done_log (kind, user_id, on_date) values (p_kind, p_uid, v_date) on conflict do nothing;
    get diagnostics v_ins = row_count;
    if v_ins = 0 then return; end if;   -- 同じ手続きでもう送っている

    select enabled, recipient into v_set from notification_settings where event_key = p_kind || ':checklist_done' and channel = 'site';
    if not found or not v_set.enabled or v_set.recipient is null then return; end if;   -- 🚨 設定が無い・オフなら送らない

    v_name := regexp_replace(coalesce(p.name, ''), '[[:space:]　]+', ' ', 'g');
    -- 🚨 event_key は付けない（付けるとスマホの送信待ちに積まれる）。ベルだけ。押すとその方の手続き（reference_id）
    insert into notifications (user_id, message, sub_message, source_type, reference_id, created_by, banner_dismissed)
    select distinct r.uid,
           format('✅ %sさんの%sの手続きがすべて完了しました', v_name, v_label),
           format('%s日 %s', v_label, to_char(v_date, 'FMMM/FMDD')),
           p_kind || ':checklist_done', p_uid::text, p_actor, true
      from resolve_role_recipients(p_uid, v_set.recipient::jsonb) r(uid)
     where p_actor is null or r.uid <> p_actor;
  exception when others then
    -- 🚨 お知らせの失敗で、済みにする操作・項目の変更・初めてのログインを巻き込まない
    raise warning '[staff_checklist_done_check] % % の判定に失敗しました: %', p_kind, p_uid, sqlerrm;
  end;
end;
$function$;
revoke execute on function public.staff_checklist_done_check(text, uuid, uuid) from public;
revoke execute on function public.staff_checklist_done_check(text, uuid, uuid) from anon;
revoke execute on function public.staff_checklist_done_check(text, uuid, uuid) from authenticated;

-- チェックを足したとき（済み・対象外・初めてのログインの自動の済み）
create or replace function public.staff_checklist_on_check()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  begin
    perform staff_checklist_done_check(case tg_table_name when 'hire_checklist_checks' then 'hire' else 'retire' end, new.user_id, new.done_by);
  exception when others then
    raise warning '[staff_checklist_on_check] %', sqlerrm;
  end;
  return null;
end;
$function$;
revoke execute on function public.staff_checklist_on_check() from public;
revoke execute on function public.staff_checklist_on_check() from anon;
revoke execute on function public.staff_checklist_on_check() from authenticated;

drop trigger if exists trg_hire_checklist_done on public.hire_checklist_checks;
create trigger trg_hire_checklist_done after insert on public.hire_checklist_checks
  for each row execute function public.staff_checklist_on_check();
drop trigger if exists trg_retire_checklist_done on public.retire_checklist_checks;
create trigger trg_retire_checklist_done after insert on public.retire_checklist_checks
  for each row execute function public.staff_checklist_on_check();

-- 項目を変えたとき（必須を外す・隠す・削除で、残りが0になる人がいる）。一覧に出る人を全員調べる（数人なので軽い）
create or replace function public.staff_checklist_on_item_change()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_kind text := case tg_table_name when 'hire_checklist_items' then 'hire' else 'retire' end;
  r record;
begin
  begin
    for r in
      select id from profiles
       where (v_kind = 'hire' and hire_date is not null and retired_at is null and retire_date is null and coalesce(approval_status, '') <> 'pending')
          or (v_kind = 'retire' and retire_date is not null)
    loop
      perform staff_checklist_done_check(v_kind, r.id, auth.uid());
    end loop;
  exception when others then
    raise warning '[staff_checklist_on_item_change] %', sqlerrm;
  end;
  return null;
end;
$function$;
revoke execute on function public.staff_checklist_on_item_change() from public;
revoke execute on function public.staff_checklist_on_item_change() from anon;
revoke execute on function public.staff_checklist_on_item_change() from authenticated;

drop trigger if exists trg_hire_checklist_item_done on public.hire_checklist_items;
create trigger trg_hire_checklist_item_done after update or delete on public.hire_checklist_items
  for each statement execute function public.staff_checklist_on_item_change();
drop trigger if exists trg_retire_checklist_item_done on public.retire_checklist_items;
create trigger trg_retire_checklist_item_done after update or delete on public.retire_checklist_items
  for each statement execute function public.staff_checklist_on_item_change();

-- ── 6. バックフィル：いま全部済んでいる人は「送った」ことにする ──
insert into staff_checklist_done_log (kind, user_id, on_date, notified_at)
select 'hire', p.id, p.hire_date, now() from profiles p
 where p.hire_date is not null and p.retired_at is null and p.retire_date is null and coalesce(p.approval_status, '') <> 'pending'
   and staff_checklist_remaining('hire', p.id) = 0
on conflict do nothing;
insert into staff_checklist_done_log (kind, user_id, on_date, notified_at)
select 'retire', p.id, p.retire_date, now() from profiles p
 where p.retire_date is not null and staff_checklist_remaining('retire', p.id) = 0
on conflict do nothing;

-- ── 7. 通知設定（宛先は入社の準備のお知らせと同じ）──
-- 🚨 ベルの行だけ入れる。通知設定の画面は「行がある方法」だけを出す作りなので、スマホ・メール・Slack の行を入れると
--    押しても届かないスイッチが出てしまう（このお知らせは event_key を付けないのでスマホには送れない）
insert into notification_settings (event_key, channel, enabled, recipient) values
  ('hire:checklist_done',   'site',  true,  '{"roles":["マネージャー","社長","管理者"],"groupFilter":"all"}'),
  ('retire:checklist_done', 'site',  true,  '{"roles":["マネージャー","社長","管理者"],"groupFilter":"all"}')
on conflict (event_key, channel) do nothing;

commit;
