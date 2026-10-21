-- ============================================================
-- 2026-10-21  休職（段5：休職のチェックリスト）
-- 計画：docs/計画-休職と手続き.md ／ docs/計画-休職-段5-段6.md（レビューと一問一答の結果）
-- ============================================================
-- 作るもの
--   ・表 leave_checklist_items（項目・phase＝'start' 休職に入るとき／'return' 復職するとき）
--       auto_key 'push'＝「スマホの通知の希望を本人に確認する」。値と確認した日時は staff_leaves（push_on／push_asked_at／push_asked_by）に持ち、チェックの行は作らない
--       🚨 phase と auto_key はあとから変えられない（チェックの記録が黙って別の段に移る・値が二重になるため）
--   ・表 leave_checklist_checks（済み・対象外の記録・休職の1回ごと）／leave_notes（メモ・チェックとは別の表＝入社・退職と同じ理由）
--   ・staff_leave_set_push(休職, 値)：手続きのカード（マネージャー以上）と本人の「設定」（今日休職中の本人）の両方が通る1本
--   ・leave_checklist_overview()：手続きの「休職」タブ・ホームの案内・タブの人数が使う1本（残りの数え方はここだけ・マネージャー以上）
--       「復職するとき」の残りは、復職の日（早く戻った日か復職日）の7日前から数える（休職の間ずっと黄色い案内が出ないように）
--   ・全部済んだら「✅ ◯◯さんの休職の手続き（休職に入るとき）がすべて完了しました」をベルだけ（1つの休職・1つの段で1回）
--       🚨 宛先は通知設定の役職のうち、マネージャー以上と管理者だけ（設定を広げても「休職」の文字が一般のスタッフに届かないように）
--   ・朝のお知らせ staff_leave_daily_notices を本番の実定義から作り直す：入社の hire_checklist_notify と同じ形（5分ごと・送る時刻を過ぎたら・
--       1人ずつ exception・送った記録 leave_notify_log）。1人1日1通にまとめる。復職の日に閉じた行（0:00 の leave_sync）も見る
--   ・staff_on_leave_ids(true) の意味を「スマホの通知を『安否確認・緊急のみ』にしている休職中の人」に変える
--       （2026-10-21 ユーザー確定：連絡板だけの「受け取る／受け取らない」はやめた。管理者からのお知らせのベルは全員に届け、メールだけ push_on に合わせる）
-- 🚨 いま休職中の人は 0 人。適用しても誰の動きも変わらない。新しい表は GRANT を同じファイルに書く（2026-10-30 からの Supabase の変更）
--
-- ロールバック手順（逆順）:
--   select cron.unschedule('staff-leave-daily-notices'); select cron.schedule('staff-leave-daily-notices', '0 0 * * *', $$select public.staff_leave_daily_notices()$$);
--   staff_leave_daily_notices・staff_on_leave_ids をこのファイルの「元の定義」のコメントの版に戻す
--   drop function staff_leave_set_push(uuid, boolean), leave_checklist_overview(), leave_checklist_remaining(uuid, text),
--     leave_checklist_return_base(uuid), leave_checklist_done_check(uuid, text, uuid), leave_checklist_on_check(), leave_checklist_on_item_change(),
--     leave_checklist_item_guard(), leave_checklist_check_guard(), leave_checklist_recipients(uuid);
--   drop table leave_notify_log, leave_checklist_done_log, leave_notes, leave_checklist_checks, leave_checklist_items;
--   alter table staff_leaves drop column push_asked_by;
--   delete from notification_settings where event_key = 'leave:checklist_done'; delete from reminder_days_settings where event_key = 'leave_checklist_notify';

begin;

-- ── 1. 項目 ─────────────────────────────────────────────
create table if not exists public.leave_checklist_items (
  id          uuid primary key default gen_random_uuid(),
  phase       text not null check (phase in ('start', 'return')),
  label       text not null,
  required    boolean not null default true,
  sort_order  integer not null default 0,
  active      boolean not null default true,
  choices     text[],
  auto_key    text check (auto_key in ('push')),
  updated_by  uuid references public.profiles(id) on delete set null,
  updated_at  timestamptz,
  created_at  timestamptz not null default now()
);
create unique index if not exists leave_checklist_items_auto_key on public.leave_checklist_items (auto_key) where auto_key is not null;
comment on table public.leave_checklist_items is '休職の手続きの項目（phase＝start 休職に入るとき／return 復職するとき）。auto_key=push は staff_leaves.push_on とつながる（2026-10-21）';

alter table public.leave_checklist_items enable row level security;
drop policy if exists leave_checklist_items_select on public.leave_checklist_items;
drop policy if exists leave_checklist_items_insert on public.leave_checklist_items;
drop policy if exists leave_checklist_items_update on public.leave_checklist_items;
drop policy if exists leave_checklist_items_delete on public.leave_checklist_items;
create policy leave_checklist_items_select on public.leave_checklist_items for select to authenticated using (is_manager_plus());
create policy leave_checklist_items_insert on public.leave_checklist_items for insert to authenticated with check (is_manager_plus());
create policy leave_checklist_items_update on public.leave_checklist_items for update to authenticated using (is_manager_plus()) with check (is_manager_plus());
create policy leave_checklist_items_delete on public.leave_checklist_items for delete to authenticated using (is_admin());
revoke all on public.leave_checklist_items from anon;
grant select, insert, update, delete on public.leave_checklist_items to authenticated;
grant all on public.leave_checklist_items to service_role;

-- 最終変更の人と日時・phase と auto_key の守り
create or replace function public.leave_checklist_item_guard()
returns trigger
language plpgsql security definer set search_path to 'public'
as $function$
begin
  if tg_op = 'INSERT' then
    -- 自動の項目を足せるのは管理者だけ（画面から直接は足さない）
    if new.auto_key is not null and auth.uid() is not null and not coalesce(is_admin(), false) then
      raise exception 'LEAVE_CHECKLIST_AUTO_KEY: 自動の項目は管理者だけが足せます' using errcode = '42501';
    end if;
  else
    if new.phase is distinct from old.phase then
      raise exception 'LEAVE_CHECKLIST_PHASE: 項目の段（休職に入るとき／復職するとき）はあとから変えられません';
    end if;
    if new.auto_key is distinct from old.auto_key then
      raise exception 'LEAVE_CHECKLIST_AUTO_KEY: 自動の項目の設定はあとから変えられません';
    end if;
  end if;
  new.updated_by := coalesce(auth.uid(), new.updated_by);
  new.updated_at := now();
  return new;
end;
$function$;
revoke execute on function public.leave_checklist_item_guard() from public, anon, authenticated;
drop trigger if exists trg_leave_checklist_item_guard on public.leave_checklist_items;
create trigger trg_leave_checklist_item_guard before insert or update on public.leave_checklist_items
  for each row execute function public.leave_checklist_item_guard();

-- 初めの項目（2026-10-21 ユーザー確定）。auth.uid() が空（migration）なので auto_key の守りは通る
insert into public.leave_checklist_items (phase, label, required, sort_order, choices, auto_key)
select * from (values
  ('start',  'スマホの通知の希望を本人に確認する',               true,  10, array['すべて送る', '安否確認・緊急のみ'], 'push'),
  ('start',  '休職中に使える機能（連絡板・交通費など）を本人に伝える', true,  20, null::text[], null::text),
  ('return', '復職日を本人と確かめる',                          true,  10, null::text[], null::text),
  ('return', '復職後の勤務（曜日・校）を本人と確かめる',          true,  20, null::text[], null::text),
  ('return', 'シフトの表に戻っているか確かめる',                 false, 30, null::text[], null::text)
) v(phase, label, required, sort_order, choices, auto_key)
where not exists (select 1 from public.leave_checklist_items);

-- ── 2. 済み・対象外の記録 ─────────────────────────────────
create table if not exists public.leave_checklist_checks (
  id          uuid primary key default gen_random_uuid(),
  leave_id    uuid not null references public.staff_leaves(id) on delete cascade,
  item_id     uuid references public.leave_checklist_items(id) on delete set null,
  item_label  text,
  choice      text,
  na          boolean not null default false,
  done_by     uuid references public.profiles(id) on delete set null default auth.uid(),
  done_at     timestamptz not null default now(),
  unique (leave_id, item_id)
);
create index if not exists leave_checklist_checks_leave on public.leave_checklist_checks (leave_id);
comment on table public.leave_checklist_checks is '休職の手続きの済み・対象外の記録（行がある＝済み）。段は項目から決める。自動の項目（auto_key）の行は作らない（2026-10-21）';

alter table public.leave_checklist_checks enable row level security;
drop policy if exists leave_checklist_checks_select on public.leave_checklist_checks;
drop policy if exists leave_checklist_checks_insert on public.leave_checklist_checks;
drop policy if exists leave_checklist_checks_delete on public.leave_checklist_checks;
create policy leave_checklist_checks_select on public.leave_checklist_checks for select to authenticated using (is_manager_plus());
create policy leave_checklist_checks_insert on public.leave_checklist_checks for insert to authenticated with check (is_manager_plus());
create policy leave_checklist_checks_delete on public.leave_checklist_checks for delete to authenticated using (is_manager_plus());
revoke all on public.leave_checklist_checks from anon;
grant select, insert, delete on public.leave_checklist_checks to authenticated;
grant all on public.leave_checklist_checks to service_role;

-- 自動の項目の行は作らせない（値は staff_leave_set_push で）・取り消した休職には書かせない
create or replace function public.leave_checklist_check_guard()
returns trigger
language plpgsql security definer set search_path to 'public'
as $function$
begin
  if exists (select 1 from leave_checklist_items i where i.id = new.item_id and i.auto_key is not null) then
    raise exception 'LEAVE_CHECKLIST_AUTO: この項目は［すべて送る］［安否確認・緊急のみ］から選んでください';
  end if;
  if exists (select 1 from staff_leaves l where l.id = new.leave_id and l.cancelled_at is not null) then
    raise exception '取り消した休職の手続きは変えられません';
  end if;
  return new;
end;
$function$;
revoke execute on function public.leave_checklist_check_guard() from public, anon, authenticated;
drop trigger if exists trg_leave_checklist_check_guard on public.leave_checklist_checks;
create trigger trg_leave_checklist_check_guard before insert on public.leave_checklist_checks
  for each row execute function public.leave_checklist_check_guard();

-- ── 3. メモ ───────────────────────────────────────────
create table if not exists public.leave_notes (
  id          uuid primary key default gen_random_uuid(),
  leave_id    uuid not null references public.staff_leaves(id) on delete cascade,
  item_id     uuid references public.leave_checklist_items(id) on delete set null,
  item_label  text,
  memo        text not null check (length(memo) between 1 and 2000),
  updated_by  uuid references public.profiles(id) on delete set null default auth.uid(),
  updated_at  timestamptz not null default now()
);
create index if not exists leave_notes_leave on public.leave_notes (leave_id);
comment on table public.leave_notes is '休職の手続きのメモ（item_id なし・item_label なし＝その方ぜんたい）。チェックとは別の表（メモを書いただけで残りから消えないように）（2026-10-21）';

alter table public.leave_notes enable row level security;
drop policy if exists leave_notes_select on public.leave_notes;
drop policy if exists leave_notes_write on public.leave_notes;
create policy leave_notes_select on public.leave_notes for select to authenticated using (is_manager_plus());
create policy leave_notes_write on public.leave_notes for all to authenticated
  using (is_manager_plus())
  with check (is_manager_plus() and updated_by = auth.uid());
revoke all on public.leave_notes from anon;
grant select, insert, update, delete on public.leave_notes to authenticated;
grant all on public.leave_notes to service_role;

-- ── 4. スマホの通知の希望 ──────────────────────────────────
alter table public.staff_leaves add column if not exists push_asked_by uuid references public.profiles(id) on delete set null;

-- ── 5. 残りの数え方（ここだけ）────────────────────────────────
-- 復職の日：［今日から復職にする］で早く戻った日、なければ復職日（空＝未定）
create or replace function public.leave_checklist_return_base(p_leave uuid)
returns date
language sql stable security definer set search_path to 'public'
as $function$
  select case when l.end_reason = 'returned' and l.ended_at is not null
              then (l.ended_at at time zone 'Asia/Tokyo')::date else l.return_date end
    from staff_leaves l where l.id = p_leave;
$function$;
revoke execute on function public.leave_checklist_return_base(uuid) from public, anon, authenticated;

-- 使っている必須の項目のうち、ふつうの項目は記録が無いもの、自動の項目（push）は確認した日時が空のもの
create or replace function public.leave_checklist_remaining(p_leave uuid, p_phase text)
returns integer
language sql stable security definer set search_path to 'public'
as $function$
  select count(*)::int
    from leave_checklist_items i
    join staff_leaves l on l.id = p_leave
   where i.active and i.required and i.phase = p_phase
     and case when i.auto_key = 'push' then l.push_asked_at is null
              else not exists (select 1 from leave_checklist_checks c where c.leave_id = p_leave and c.item_id = i.id) end;
$function$;
revoke execute on function public.leave_checklist_remaining(uuid, text) from public, anon, authenticated;

-- 手続きの「休職」タブ・ホームの案内・タブの人数が使う一覧。1つの休職につき段ごとに1行
--   出す休職：取消でない・退職で閉じていない・在籍。終わっていない休職と、終わって60日以内の休職
--   due：いま「残り」として数えるか（休職に入るとき＝終わっていない休職。復職するとき＝復職の日の7日前から・復職して60日まで）
create or replace function public.leave_checklist_overview()
returns table (leave_id uuid, user_id uuid, name text, start_date date, return_date date, return_base date,
               ended_at timestamptz, phase text, remaining integer, due boolean)
language plpgsql stable security definer set search_path to 'public'
as $function$
#variable_conflict use_column
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
begin
  if not is_manager_plus() then return; end if;
  return query
    with ls as (
      select l.id, l.user_id, p.name, l.start_date, l.return_date, l.ended_at,
             leave_checklist_return_base(l.id) as base
        from staff_leaves l join profiles p on p.id = l.user_id
       where l.cancelled_at is null
         and l.end_reason is distinct from 'retired'
         and p.is_active
         and (l.ended_at is null or (l.ended_at at time zone 'Asia/Tokyo')::date >= v_today - 60)
    )
    select ls.id, ls.user_id, ls.name, ls.start_date, ls.return_date, ls.base, ls.ended_at, ph.phase,
           leave_checklist_remaining(ls.id, ph.phase),
           case when ph.phase = 'start' then ls.ended_at is null
                else ls.base is not null and ls.base - 7 <= v_today and ls.base >= v_today - 60 end
      from ls cross join (values ('start'), ('return')) ph(phase)
     order by ls.start_date, ls.id, ph.phase desc;
end;
$function$;
revoke execute on function public.leave_checklist_overview() from public, anon;
grant execute on function public.leave_checklist_overview() to authenticated;

-- ── 6. 全部済んだらベル（1つの休職・1つの段で1回）───────────────
create table if not exists public.leave_checklist_done_log (
  leave_id    uuid not null references public.staff_leaves(id) on delete cascade,
  phase       text not null check (phase in ('start', 'return')),
  notified_at timestamptz not null default now(),
  primary key (leave_id, phase)
);
alter table public.leave_checklist_done_log enable row level security;
-- 🚨 画面からは読まない・書かない（ポリシーなし・authenticated に権限なし＝SECURITY DEFINER の関数だけが触る）
revoke all on public.leave_checklist_done_log from anon, authenticated;
grant all on public.leave_checklist_done_log to service_role;
comment on table public.leave_checklist_done_log is '休職の手続きがすべて済んだお知らせを送った記録（1つの休職・1つの段で1回だけ・2026-10-21）';

-- leave:* のベルの宛先：マネージャー以上（休職中を除く）と管理者だけ。本人は除く
create or replace function public.leave_checklist_recipients(p_user uuid)
returns setof uuid
language sql stable security definer set search_path to 'public'
as $function$
  select x.id from (
    select p.id from profiles p where p.is_active and role_is_manager_plus(p.id) and not staff_on_leave(p.id)
    union select staff_admin_ids()
  ) x where x.id <> p_user;
$function$;
revoke execute on function public.leave_checklist_recipients(uuid) from public, anon, authenticated;

create or replace function public.leave_checklist_done_check(p_leave uuid, p_phase text, p_actor uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $function$
declare
  l       record;
  v_set   record;
  v_ins   integer;
  v_name  text;
  v_label text := case p_phase when 'start' then '休職に入るとき' else '復職するとき' end;
  v_sub   text;
  v_base  date;
begin
  begin
    select sl.*, p.name, p.is_active into l from staff_leaves sl join profiles p on p.id = sl.user_id where sl.id = p_leave;
    if not found or l.cancelled_at is not null or l.end_reason = 'retired' or not l.is_active then return; end if;
    if p_phase not in ('start', 'return') then return; end if;
    -- 必須の項目が1つも無い段は「済んだ」にしない
    if not exists (select 1 from leave_checklist_items where active and required and phase = p_phase) then return; end if;
    if leave_checklist_remaining(p_leave, p_phase) > 0 then return; end if;

    insert into leave_checklist_done_log (leave_id, phase) values (p_leave, p_phase) on conflict do nothing;
    get diagnostics v_ins = row_count;
    if v_ins = 0 then return; end if;

    select enabled, recipient into v_set from notification_settings where event_key = 'leave:checklist_done' and channel = 'site';
    if not found or not v_set.enabled or v_set.recipient is null then return; end if;   -- 🚨 設定が無い・オフなら送らない

    v_name := regexp_replace(coalesce(l.name, ''), '[[:space:]　]+', ' ', 'g');
    if p_phase = 'start' then
      v_sub := '休職の初日 ' || to_char(l.start_date, 'FMMM/FMDD');
    else
      v_base := leave_checklist_return_base(p_leave);
      v_sub := case when v_base is null then '復職日 未定' else '復職日 ' || to_char(v_base, 'FMMM/FMDD') end;
    end if;
    -- 🚨 event_key を付けない（スマホに出さない）。宛先は通知設定の役職のうち、マネージャー以上と管理者だけ
    insert into notifications (user_id, message, sub_message, source_type, reference_id, created_by, banner_dismissed)
    select distinct r.uid,
           format('✅ %sさんの休職の手続き（%s）がすべて完了しました', v_name, v_label),
           v_sub, 'leave:checklist_done', l.user_id::text, p_actor, true
      from resolve_role_recipients(l.user_id, v_set.recipient::jsonb) r(uid)
     where r.uid in (select leave_checklist_recipients(l.user_id))
       and (p_actor is null or r.uid <> p_actor);
  exception when others then
    -- 🚨 お知らせの失敗で、済みにする操作・項目の変更・希望の変更を巻き込まない
    raise warning '[leave_checklist_done_check] % % の判定に失敗しました: %', p_leave, p_phase, sqlerrm;
  end;
end;
$function$;
revoke execute on function public.leave_checklist_done_check(uuid, text, uuid) from public, anon, authenticated;

create or replace function public.leave_checklist_on_check()
returns trigger
language plpgsql security definer set search_path to 'public'
as $function$
declare v_phase text;
begin
  begin
    select phase into v_phase from leave_checklist_items where id = new.item_id;
    if v_phase is not null then perform leave_checklist_done_check(new.leave_id, v_phase, new.done_by); end if;
  exception when others then
    raise warning '[leave_checklist_on_check] %', sqlerrm;
  end;
  return null;
end;
$function$;
revoke execute on function public.leave_checklist_on_check() from public, anon, authenticated;
drop trigger if exists trg_leave_checklist_done on public.leave_checklist_checks;
create trigger trg_leave_checklist_done after insert on public.leave_checklist_checks
  for each row execute function public.leave_checklist_on_check();

-- 項目を変えたとき（必須を外す・隠す・削除で、残りが0になる休職がある）。出ている休職だけを調べる（数件）
create or replace function public.leave_checklist_on_item_change()
returns trigger
language plpgsql security definer set search_path to 'public'
as $function$
declare r record;
begin
  begin
    for r in
      select l.id from staff_leaves l join profiles p on p.id = l.user_id
       where l.cancelled_at is null and l.end_reason is distinct from 'retired' and p.is_active
         and (l.ended_at is null or l.ended_at > now() - interval '60 days')
    loop
      perform leave_checklist_done_check(r.id, 'start', auth.uid());
      perform leave_checklist_done_check(r.id, 'return', auth.uid());
    end loop;
  exception when others then
    raise warning '[leave_checklist_on_item_change] %', sqlerrm;
  end;
  return null;
end;
$function$;
revoke execute on function public.leave_checklist_on_item_change() from public, anon, authenticated;
drop trigger if exists trg_leave_checklist_item_done on public.leave_checklist_items;
create trigger trg_leave_checklist_item_done after update or delete on public.leave_checklist_items
  for each statement execute function public.leave_checklist_on_item_change();

-- ── 7. スマホの通知の希望を変える（手続きのカード・本人の「設定」の両方）──────────
create or replace function public.staff_leave_set_push(p_leave uuid, p_on boolean)
returns void
language plpgsql security definer set search_path to 'public'
as $function$
declare
  l record;
begin
  if p_on is null then raise exception 'スマホの通知の希望を選んでください'; end if;
  select * into l from staff_leaves where id = p_leave;
  if not found then raise exception 'この休職は見つかりません'; end if;
  if l.cancelled_at is not null or l.ended_at is not null then raise exception '終わった・取り消した休職の希望は変えられません'; end if;
  -- マネージャー以上・管理者：終わっていない休職ならいつでも／本人：今日休職中のときだけ（「設定」の行は休職中だけ出す）
  if not (is_manager_plus() or (l.user_id = auth.uid() and staff_on_leave(auth.uid()))) then
    raise exception 'この希望を変えられるのは、マネージャー以上・管理者とご本人だけです' using errcode = '42501';
  end if;
  update staff_leaves
     set push_on = p_on, push_asked_at = now(), push_asked_by = auth.uid(), updated_at = now()
   where id = p_leave and cancelled_at is null and ended_at is null;
  if not found then raise exception '希望を保存できませんでした'; end if;
  perform leave_checklist_done_check(p_leave, 'start', auth.uid());
end;
$function$;
revoke execute on function public.staff_leave_set_push(uuid, boolean) from public, anon;
grant execute on function public.staff_leave_set_push(uuid, boolean) to authenticated;

-- ── 8. 朝のお知らせ（作り直し）──────────────────────────────
create table if not exists public.leave_notify_log (
  notice_key text not null,   -- 休職の id（1人1日1通）か 'undecided'（毎月1日）
  on_date    date not null,
  sent_at    timestamptz not null default now(),
  primary key (notice_key, on_date)
);
alter table public.leave_notify_log enable row level security;
revoke all on public.leave_notify_log from anon, authenticated;
grant all on public.leave_notify_log to service_role;
comment on table public.leave_notify_log is '休職の朝のお知らせを送った記録（同じ日の二重送信を防ぐ）。400日より古い行は staff_leave_daily_notices が消す（2026-10-21）';

insert into public.reminder_days_settings (event_key, days_before, send_hour, send_minute)
values ('leave_checklist_notify', array[7, 3, 1], 9, 0)
on conflict (event_key) do nothing;

-- 元の定義（2026-10-20 本番・ロールバック用）：毎日 9:00 JST に1回。終わっていない休職だけ回し、
--   ① 復職日の7日前と前日「📋 ◯◯さんが M/D に復職予定です。日付が変わる場合は、管理者が［休職を修正］から直します。」（staff_leave:return_soon）
--   ② 休職の初日に受理待ちがあれば「📋 ◯◯さんあての受理待ちがN件あります。付け替えてください。」（staff_leave:pending・①を上書き）
--   ③ 毎月1日「📋 復職日が未定の方がN人います。」（staff_leave:undecided・reference_id は日付）。宛先はマネージャー以上（休職中を除く）と管理者・本人は除く
create or replace function public.staff_leave_daily_notices()
returns integer
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_now    timestamp := now() at time zone 'Asia/Tokyo';
  v_today  date := (now() at time zone 'Asia/Tokyo')::date;
  v_days   int[];
  v_hour   int;
  v_minute int;
  v_n      integer := 0;
  l        record;
  v_cnt    integer;
  v_ins    integer;
  v_msg    text;
  v_src    text;
  v_name   text;
  v_base   date;
  v_start_rest  integer;
  v_return_rest integer;
  v_pending     integer;
begin
  select days_before, send_hour, send_minute into v_days, v_hour, v_minute
    from reminder_days_settings where event_key = 'leave_checklist_notify';
  v_days := coalesce(v_days, array[7, 3, 1]);
  -- 送る時刻より前なら何もしない（cron は5分ごと）
  if v_now < v_today + make_time(coalesce(v_hour, 9), coalesce(v_minute, 0), 0) then
    return 0;
  end if;
  delete from leave_notify_log where on_date < v_today - 400;

  for l in
    select sl.*, p.name as person_name
      from staff_leaves sl join profiles p on p.id = sl.user_id
     where sl.cancelled_at is null and p.is_active
       and sl.end_reason is distinct from 'retired'
       -- 終わっていない休職と、復職の日が今日の休職（0:00 の leave_sync が復職日に閉じる・早く戻った日も）
       and (sl.ended_at is null or leave_checklist_return_base(sl.id) = v_today)
  loop
    begin
      v_msg := null; v_src := null;
      v_name := regexp_replace(coalesce(l.person_name, ''), '[[:space:]　]+', ' ', 'g');
      v_base := leave_checklist_return_base(l.id);
      v_start_rest  := case when l.ended_at is null then leave_checklist_remaining(l.id, 'start') else 0 end;
      v_return_rest := leave_checklist_remaining(l.id, 'return');

      if l.ended_at is null and l.start_date = v_today then
        -- 休職の初日：受理待ちと、休職に入るときの残り
        select (select count(*) from leave_requests where approver_id = l.user_id and status = 'pending')
             + (select count(*) from leave_requests where approver2_id = l.user_id and status in ('pending', 'manager_approved'))
             + (select count(*) from overtime_reports where reviewer_id = l.user_id and status not in ('confirmed', 'cancelled') and applicant_id is distinct from l.user_id)
             + (select count(*) from shift_reports where reviewer_id = l.user_id and status = 'pending')
          into v_pending;
        if v_pending > 0 then
          v_msg := format('📋 %sさんの休職が今日から始まりました。受理待ち%s件の付け替え%sをお願いします。', v_name, v_pending,
                          case when v_start_rest > 0 then format('と、休職に入るときの手続き（残り%s件）', v_start_rest) else '' end);
          v_src := 'staff_leave:pending';
        elsif v_start_rest > 0 then
          v_msg := format('📋 %sさんの休職が今日から始まりました。休職に入るときの手続きが残り%s件あります。', v_name, v_start_rest);
          v_src := 'leave:remind';
        end if;
      elsif l.ended_at is null and l.return_date is not null and (l.return_date - 7 = v_today or l.return_date - 1 = v_today) then
        -- 復職日の7日前と前日（日付の直し忘れを防ぐ・いつも）。復職するときの残りがあれば同じ1通に
        v_msg := format('📋 %sさんが %s に復職予定です。%s日付が変わる場合は、管理者が［休職を修正］から直します。', v_name,
                        to_char(l.return_date, 'FMMM/FMDD'),
                        case when v_return_rest > 0 then format('復職するときの手続きが残り%s件あります。', v_return_rest) else '' end);
        v_src := 'staff_leave:return_soon';
      elsif l.ended_at is null and l.start_date > v_today and (l.start_date - v_today) = any (v_days) and v_start_rest > 0 then
        -- 休職の初日の◯日前：休職に入るときの残りがあるときだけ
        v_msg := format('📋 %sさんは %s から休職です。休職に入るときの手続きが残り%s件あります。', v_name, to_char(l.start_date, 'FMMM/FMDD'), v_start_rest);
        v_src := 'leave:remind';
      elsif v_base is not null and v_return_rest > 0 and (v_base = v_today or (v_base > v_today and (v_base - v_today) = any (v_days))) then
        -- 復職の日の◯日前・当日：復職するときの残りがあるときだけ
        v_msg := case when v_base = v_today
                      then format('📋 %sさんが今日復職しました。復職するときの手続きが残り%s件あります。', v_name, v_return_rest)
                      else format('📋 %sさんが %s に復職予定です。復職するときの手続きが残り%s件あります。', v_name, to_char(v_base, 'FMMM/FMDD'), v_return_rest) end;
        v_src := 'leave:remind';
      end if;

      if v_msg is not null then
        insert into leave_notify_log (notice_key, on_date) values (l.id::text, v_today) on conflict do nothing;
        get diagnostics v_ins = row_count;
        if v_ins > 0 then
          insert into notifications (user_id, message, source_type, reference_id, read)
          select r, v_msg, v_src, l.user_id::text, false from leave_checklist_recipients(l.user_id) r;
          get diagnostics v_cnt = row_count; v_n := v_n + v_cnt;
        end if;
      end if;
    exception when others then
      -- 🚨 1人の失敗でほかの人のお知らせを止めない
      raise warning '[staff_leave_daily_notices] % のお知らせに失敗しました: %', l.id, sqlerrm;
    end;
  end loop;

  -- 毎月1日：復職日が未定の休職中の方
  if extract(day from v_today) = 1 then
    begin
      select count(*) into v_cnt from staff_leaves sl join profiles p on p.id = sl.user_id
       where sl.ended_at is null and sl.cancelled_at is null and sl.return_date is null and sl.start_date <= v_today and p.is_active;
      if v_cnt > 0 then
        insert into leave_notify_log (notice_key, on_date) values ('undecided', v_today) on conflict do nothing;
        get diagnostics v_ins = row_count;
        if v_ins > 0 then
          insert into notifications (user_id, message, source_type, reference_id, read)
          select x.id, '📋 復職日が未定の方が' || v_cnt || '人います。', 'staff_leave:undecided', to_char(v_today, 'YYYY-MM-DD'), false
            from (select p.id from profiles p where p.is_active and role_is_manager_plus(p.id) and not staff_on_leave(p.id)
                  union select staff_admin_ids()) x;
          get diagnostics v_cnt = row_count; v_n := v_n + v_cnt;
        end if;
      end if;
    exception when others then
      raise warning '[staff_leave_daily_notices] 復職日が未定のお知らせに失敗しました: %', sqlerrm;
    end;
  end if;
  return v_n;
end;
$function$;
revoke execute on function public.staff_leave_daily_notices() from public, anon, authenticated;

-- 🚨 今日の 9:00 の分（作り直す前の版）が送り済みなら、今日はもう送らない
insert into public.leave_notify_log (notice_key, on_date)
select l.id::text, (now() at time zone 'Asia/Tokyo')::date from public.staff_leaves l
 where (now() at time zone 'Asia/Tokyo')::time >= time '09:00'
on conflict do nothing;

select cron.unschedule('staff-leave-daily-notices') where exists (select 1 from cron.job where jobname = 'staff-leave-daily-notices');
select cron.schedule('staff-leave-daily-notices', '*/5 * * * *', $$select public.staff_leave_daily_notices()$$);

-- ── 9. 管理者からのお知らせ：メールだけ止める人 ───────────────────
-- 元の定義：... and (not p_quiet_only or not l.board_opt_in)
-- p_quiet_only = true：スマホの通知を「安否確認・緊急のみ」（push_on=false）にしている休職中の人（announcement-notify／remind がメールを送らない）
create or replace function public.staff_on_leave_ids(p_quiet_only boolean default false)
returns setof uuid
language sql stable security definer set search_path to 'public'
as $function$
  select l.user_id from staff_leaves l
   where l.ended_at is null and l.cancelled_at is null and staff_on_leave(l.user_id)
     and (not p_quiet_only or not l.push_on);
$function$;
revoke execute on function public.staff_on_leave_ids(boolean) from public, anon, authenticated;

-- ── 10. 通知設定（完了のベル・宛先は入社・退職と同じ）──────────────────
-- 🚨 ベルの行だけ（event_key を付けないのでスマホには送れない）
insert into notification_settings (event_key, channel, enabled, recipient) values
  ('leave:checklist_done', 'site', true, '{"roles":["マネージャー","社長","管理者"],"groupFilter":"all"}')
on conflict (event_key, channel) do nothing;

commit;
