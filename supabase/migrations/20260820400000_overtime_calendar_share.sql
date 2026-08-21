-- 残業をカレンダーに載せるかどうかを、指定された人が自分で選べるようにする
--
-- 【背景】
-- 受理された残業は自動的に Google カレンダーへ出ていた。
-- しかしマネージャーは在宅勤務・テレワークが多く、全部載るのは不都合だった。
-- 「他の人のシフトに関係する予定だけ載せたい」という要望への対応。
--
-- 【設計の要点】
-- ・show_on_calendar は **null 許容**。null は「未指定＝これまでどおりの動き」を意味する。
--   こうすることで、既存の受理済みデータを1行も書き換えずに済む。
--   🚨 UPDATE で埋めてはいけない：overtime_reports には
--      trg_enforce_furikae_no_double_count（before insert or update・old/new を比較せず毎回全検証）
--      が張られており、過去の1行でも違反があるとマイグレーション全体が例外で落ちる。
--
-- ・チェック欄を出す相手は overtime_calendar_choice_rules で指定する。
--   指定されていない人は今までどおり全部カレンダーに載る（show_on_calendar は null のまま）。
--
-- ・この列は「他の人に見せるかどうか」の設定であって、労働時間の記録ではない。
--   後から変えても合計時間数・差分・給与計算には一切影響しない。

-- ============================================================
-- ① 残業ごとの「カレンダーに載せるか」
-- ============================================================
alter table public.overtime_reports
  add column if not exists show_on_calendar boolean;

comment on column public.overtime_reports.show_on_calendar is
  'カレンダーに載せるか。null=未指定（種別ごとの既定に従う＝これまでどおり）／true=載せる／false=載せない。労働時間の記録には影響しない';

-- ============================================================
-- ② 「カレンダー掲載を自分で選べる人」の指定（役職ごと・個人ごと）
--    構造は overtime_threshold_rules（残業しきい値）に合わせてある
-- ============================================================
create table if not exists public.overtime_calendar_choice_rules (
  id uuid primary key default gen_random_uuid(),
  role_title text,
  user_id uuid references public.profiles(id) on delete cascade,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  -- 役職ルールか個人ルールのどちらか一方
  constraint overtime_calendar_choice_rules_scope_check
    check ((role_title is not null and user_id is null)
        or (role_title is null and user_id is not null))
);

-- 🚨 一意性は「部分ユニークインデックス」にしないこと。
--    PostgREST の upsert(onConflict) がターゲットにできず「追加する」が保存できなくなる
--    （overtime_threshold_rules で実際に踏んだ。CLAUDE.md 2026-07-24 / 2026-08-04）。
--    PostgreSQL は NULL 同士を重複扱いしないので、通常のユニーク制約で成立する。
alter table public.overtime_calendar_choice_rules
  drop constraint if exists overtime_calendar_choice_rules_role_title_key,
  drop constraint if exists overtime_calendar_choice_rules_user_id_key;

alter table public.overtime_calendar_choice_rules
  add constraint overtime_calendar_choice_rules_role_title_key unique (role_title),
  add constraint overtime_calendar_choice_rules_user_id_key unique (user_id);

alter table public.overtime_calendar_choice_rules enable row level security;

-- 閲覧は全員（自分にチェック欄が出るかを画面が判断するため）
drop policy if exists occr_select on public.overtime_calendar_choice_rules;
create policy occr_select on public.overtime_calendar_choice_rules
  for select to authenticated using (true);

-- 書き込みは管理者のみ
drop policy if exists occr_admin_all on public.overtime_calendar_choice_rules;
create policy occr_admin_all on public.overtime_calendar_choice_rules
  for all to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- ============================================================
-- ③ その人がチェック欄を使えるか（個人ルール > 役職ルール > 既定 false）
--    false のときはチェック欄を出さず、これまでどおり全部カレンダーに載せる
-- ============================================================
create or replace function public.overtime_can_choose_calendar(p_user uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select r.enabled
       from overtime_calendar_choice_rules r
      where r.user_id = p_user),
    (select r.enabled
       from overtime_calendar_choice_rules r
       join profiles p on p.role_title = r.role_title
      where p.id = p_user),
    false
  );
$$;

grant execute on function public.overtime_can_choose_calendar(uuid) to authenticated;
