-- 2026-09-26 連絡板：お知らせのテンプレート（個人／全体）＋ 分類
--
-- ✅ ユーザー確定（2026-09-26・一問一答）
--   ・テンプレに入るのは件名・本文だけ（宛先・期限・確認の要求は入れない）
--   ・個人テンプレ … お知らせを送れる人なら誰でも登録・修正・削除。本人だけが見る
--   ・全体テンプレ … 登録／他の人が作ったものも含めて修正・削除 は権限「連絡板：全体テンプレートの登録・変更」
--     （feature_permissions 'board_template_global'）。最初は is_leader_plus＝リーダー・マネージャー・社長・管理者。
--     使う（読む）のはログインした人全員（お知らせを送れるかは画面の設定 board_notice_send_roles で見る）
--   ・分類 … 管理画面「連絡板」タブで管理者が管理。最初の7つはここで入れる
--
-- 🚨 分類は「文字」ではなく id で結ぶ（2体レビューの指摘）。文字で持つと、管理者が分類名を変えても
--    他人の個人テンプレ（RLS で管理者にも見えない）の分類を書き換えられず、絞り込みから外れる。
--    消すときは active=false で隠す（場所予約の用途 room_purposes と同じ考え方）。
-- 🚨 update の with check は insert と同じ式にする（レビュー指摘）。「自分の個人テンプレの持ち主を他人に」
--    「全体テンプレを他人の個人テンプレに」を塞ぐ。
-- 🚨 作った人（owner_id）は on delete set null。cascade だと退職（auth.users を消す経路・delete-user）で
--    全体テンプレが黙って消える。持ち主が消えた個人テンプレは誰にも見えない迷子になるので夜間 cron で掃除する。
-- 🚨 updated_at / updated_by / owner_id は画面から送らせない。トリガーで入れる（announcements の前例と同じ形）。
-- 🚨 権限の関数は (select …) で包んで1文につき1回だけ評価させる（前例 20260915001444）。
-- 🚨 権限の検算は画面が呼ぶのと同じ命令（insert / update / delete・returning で件数）。upsert は使わない。

-- ───────────────────────────────────────────────
-- 1. 分類
-- ───────────────────────────────────────────────
create table if not exists public.board_template_categories (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  sort_order int  not null default 0,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);
comment on table public.board_template_categories is
  'お知らせのテンプレートの分類（管理画面「連絡板」タブで管理）。消さずに active=false で隠す。テンプレは category_id で結ぶ';

alter table public.board_template_categories enable row level security;

drop policy if exists board_template_categories_select on public.board_template_categories;
create policy board_template_categories_select on public.board_template_categories
  for select to authenticated using (true);

drop policy if exists board_template_categories_write on public.board_template_categories;
create policy board_template_categories_write on public.board_template_categories
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- ───────────────────────────────────────────────
-- 2. テンプレート
-- ───────────────────────────────────────────────
create table if not exists public.board_notice_templates (
  id          uuid primary key default gen_random_uuid(),
  scope       text not null check (scope in ('personal', 'global')),
  owner_id    uuid references auth.users(id) on delete set null,   -- 作った人。personal は本人＝見える範囲の鍵
  name        text not null check (length(btrim(name)) > 0),
  category_id uuid references public.board_template_categories(id) on delete set null,
  subject     text not null,
  body        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id) on delete set null
);
comment on table public.board_notice_templates is
  'お知らせのテンプレート（件名・本文）。scope=personal は owner 本人だけ／global は全員が読める。'
  'global の登録・修正・削除は feature_permissions board_template_global。owner_id / updated_* はトリガーが入れる';

create index if not exists board_notice_templates_owner_idx on public.board_notice_templates (owner_id) where scope = 'personal';

alter table public.board_notice_templates enable row level security;

-- 読む：自分の personal ＋ global は全員
drop policy if exists board_notice_templates_select on public.board_notice_templates;
create policy board_notice_templates_select on public.board_notice_templates
  for select to authenticated
  using (
    (scope = 'personal' and owner_id = (select auth.uid()))
    or scope = 'global'
  );

-- 書く（追加・更新・削除）：personal は本人／global は権限。
-- 🚨 update は using（対象の行）と with check（書き換え後の行）を**同じ式**にする
drop policy if exists board_notice_templates_insert on public.board_notice_templates;
create policy board_notice_templates_insert on public.board_notice_templates
  for insert to authenticated
  with check (
    (scope = 'personal' and owner_id = (select auth.uid()))
    or (scope = 'global' and (select public.has_feature_permission('board_template_global')))
  );

drop policy if exists board_notice_templates_update on public.board_notice_templates;
create policy board_notice_templates_update on public.board_notice_templates
  for update to authenticated
  using (
    (scope = 'personal' and owner_id = (select auth.uid()))
    or (scope = 'global' and (select public.has_feature_permission('board_template_global')))
  )
  with check (
    (scope = 'personal' and owner_id = (select auth.uid()))
    or (scope = 'global' and (select public.has_feature_permission('board_template_global')))
  );

drop policy if exists board_notice_templates_delete on public.board_notice_templates;
create policy board_notice_templates_delete on public.board_notice_templates
  for delete to authenticated
  using (
    (scope = 'personal' and owner_id = (select auth.uid()))
    or (scope = 'global' and (select public.has_feature_permission('board_template_global')))
  );

-- 作った人・最終更新は画面から送らせない（詐称と「直したのに並びが変わらない」を防ぐ）
create or replace function public.board_notice_templates_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user = 'authenticated' then
    if tg_op = 'INSERT' then
      new.owner_id := auth.uid();
    elsif new.owner_id is distinct from old.owner_id and not public.is_admin() then
      raise exception 'テンプレートの作った人は変えられません' using errcode = '42501';
    end if;
    new.updated_by := auth.uid();
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke execute on function public.board_notice_templates_guard() from public;
revoke execute on function public.board_notice_templates_guard() from anon;

drop trigger if exists trg_board_notice_templates_guard on public.board_notice_templates;
create trigger trg_board_notice_templates_guard
  before insert or update on public.board_notice_templates
  for each row execute function public.board_notice_templates_guard();

-- 分類の最終更新も同じくトリガーで
create or replace function public.board_template_categories_touch()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if current_user = 'authenticated' then new.updated_by := auth.uid(); end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke execute on function public.board_template_categories_touch() from public;
revoke execute on function public.board_template_categories_touch() from anon;

drop trigger if exists trg_board_template_categories_touch on public.board_template_categories;
create trigger trg_board_template_categories_touch
  before insert or update on public.board_template_categories
  for each row execute function public.board_template_categories_touch();

-- ───────────────────────────────────────────────
-- 3. 権限（表の権限。行の範囲は上の RLS）
-- ───────────────────────────────────────────────
-- 🚨 Supabase は新しい表に anon / authenticated へ all を自動で付ける。一度全部外してから要るものだけ付ける
revoke all on table public.board_notice_templates from anon, public, authenticated;
grant select, insert, update, delete on table public.board_notice_templates to authenticated;
grant all on table public.board_notice_templates to service_role;

revoke all on table public.board_template_categories from anon, public, authenticated;
grant select, insert, update, delete on table public.board_template_categories to authenticated;
grant all on table public.board_template_categories to service_role;

-- ───────────────────────────────────────────────
-- 4. 機能権限の行（最初は is_leader_plus＝リーダー・マネージャー・社長・管理者。フロア責任者は含まない）
-- ───────────────────────────────────────────────
-- 🚨 役職名を直に書かない（2026-09-09 の改名事故）。acts_as='leader' だとリーダーだけになるので使わない
insert into public.feature_permissions (role_id, feature_key, enabled)
select r.id, 'board_template_global', coalesce(r.is_leader_plus, false)
  from public.roles r
on conflict (role_id, feature_key) do nothing;

-- ───────────────────────────────────────────────
-- 5. 分類の初期値（何度流しても増えない）
-- ───────────────────────────────────────────────
insert into public.board_template_categories (name, sort_order) values
  ('連絡',         1),
  ('お願い・依頼', 2),
  ('注意喚起',     3),
  ('行事・イベント', 4),
  ('勤怠・シフト', 5),
  ('研修・勉強会', 6),
  ('その他',       7)
on conflict (name) do nothing;

-- ───────────────────────────────────────────────
-- 6. 掃除：持ち主が消えた個人テンプレ（誰にも見えない）を毎晩消す
-- ───────────────────────────────────────────────
select cron.unschedule(jobid) from cron.job where jobname = 'purge-board-templates-orphan';
select cron.schedule(
  'purge-board-templates-orphan',
  '45 18 * * *',   -- 3:45 JST
  $cron$ delete from public.board_notice_templates where scope = 'personal' and owner_id is null; $cron$
);

-- 確認用:
--   select r.name, fp.enabled from feature_permissions fp join roles r on r.id = fp.role_id
--    where fp.feature_key = 'board_template_global' order by r.sort_order;
--   select name, sort_order, active from board_template_categories order by sort_order;
--   select has_table_privilege('anon', 'public.board_notice_templates', 'select');  -- false
