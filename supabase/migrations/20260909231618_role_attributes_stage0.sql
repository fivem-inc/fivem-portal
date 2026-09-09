-- 役職の属性化・段0（土台）。2026-09-09 ユーザー決定（docs/計画-役職の属性化.md §9）。
--
-- 【なぜ要るか】
-- 役職名（'社長' 等）がコード46か所・RLS13本・関数10本・Edge Function 20本・データ4種に直書きされていて、
-- 改名や役職の新設（副社長・会長・エリアマネージャー）で権限が壊れる。2026-09-09 に実際に壊れた。
-- → 役職名は「表示」にだけ使い、判定は roles の属性で行う。この migration はその土台だけを作る。
--
-- 🚨 この段では **誰も新しい列を読まない**。既存の動作は変わらない（段1以降で読み始める）。
-- 🚨 すべて not null default false。nullable にすると `not r.is_x` が NULL で素通りする（09-09 の穴と同型）。

-- ========================================
-- 1) roles に属性列を足す
-- ========================================
alter table public.roles
  add column if not exists acts_as           text,
  add column if not exists is_approver       boolean not null default false,
  add column if not exists is_leader_plus    boolean not null default false,
  add column if not exists is_manager_plus   boolean not null default false,
  add column if not exists is_board_approver boolean not null default false,
  add column if not exists is_org_wide       boolean not null default false;

-- 立場は4つだけ。非一意（会長と社長が同じ 'president' に立てる）
alter table public.roles drop constraint if exists roles_acts_as_check;
alter table public.roles add constraint roles_acts_as_check
  check (acts_as is null or acts_as in ('leader', 'manager', 'accounting', 'president'));

comment on column public.roles.acts_as is
  '承認フロー上の立場（leader/manager/accounting/president）。非一意。通知の宛先キーと承認の段はこれで引く。null＝どの段にも立たない（隠居の会長など）';
comment on column public.roles.is_approver is
  '承認者。休暇・勤務変更の受理・差し戻しができる（フロア責任者を含む）';
comment on column public.roles.is_leader_plus is
  'リーダー以上。先行公開・回覧・休暇の全件閲覧（フロア責任者は含まない・2026-07-19 決定）';
comment on column public.roles.is_manager_plus is
  'マネージャー以上。安否の発信・自己受理・電話番号の閲覧（管理者を含む）';
comment on column public.roles.is_board_approver is
  '備品購入の決裁者。3万円超の全員承認・領収書の閲覧（🚨 管理者＝経理は含まない。含めると全員承認が経理の票待ちで止まる）';
comment on column public.roles.is_org_wide is
  '組織全体を見る立場。通知のグループ絞り込みの対象外・「社長のみ」先行公開の対象';

-- ========================================
-- 2) いまの7役職に、現行の動きを再現する値を入れる
--    🚨 名前で引くのはこの投入のときだけ（以後は属性で判定する）
-- ========================================
update public.roles set acts_as = null,        is_approver = false, is_leader_plus = false, is_manager_plus = false, is_board_approver = false, is_org_wide = false where name = 'パート';
update public.roles set acts_as = null,        is_approver = false, is_leader_plus = false, is_manager_plus = false, is_board_approver = false, is_org_wide = false where name = '一般';
update public.roles set acts_as = null,        is_approver = true,  is_leader_plus = false, is_manager_plus = false, is_board_approver = false, is_org_wide = false where name = 'フロア責任者';
update public.roles set acts_as = 'leader',    is_approver = true,  is_leader_plus = true,  is_manager_plus = false, is_board_approver = false, is_org_wide = false where name = 'リーダー';
update public.roles set acts_as = 'manager',   is_approver = true,  is_leader_plus = true,  is_manager_plus = true,  is_board_approver = true,  is_org_wide = false where name = 'マネージャー';
update public.roles set acts_as = 'president', is_approver = true,  is_leader_plus = true,  is_manager_plus = true,  is_board_approver = true,  is_org_wide = true  where name = '社長';
update public.roles set acts_as = 'accounting',is_approver = true,  is_leader_plus = true,  is_manager_plus = true,  is_board_approver = false, is_org_wide = true  where name = '管理者';

-- ========================================
-- 3) profiles.role_id を role_title から必ず同期するトリガー
--    🚨 DB側の判定（has_feature_permission / overtime_role_rank）は role_id を先に読む。
--       一方、画面の書き込み3か所（UsersTab / FeaturePermissionsTab / create-user）は role_title しか書かない。
--       このままでは役職を変えた瞬間からまた食い違う（09-09 に26人が食い違っていた原因）。
--    → role_title を正とし、role_id はここで必ず導出する。手で role_id を書いても上書きされる。
--    🚨 roles に無い名前を書こうとしたら止める（黙って null にすると「権限が読めない人」が静かに増える）。
-- ========================================
create or replace function public.profiles_sync_role_id()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if new.role_title is null or btrim(new.role_title) = '' then
    new.role_id := null;
    return new;
  end if;
  select id into v_id from roles where name = new.role_title;
  if v_id is null then
    raise exception '役職「%」は登録されていません（管理画面 → 権限管理 で先に追加してください）', new.role_title
      using errcode = '23503';
  end if;
  new.role_id := v_id;
  return new;
end;
$$;

drop trigger if exists trg_profiles_sync_role_id on public.profiles;
create trigger trg_profiles_sync_role_id
  before insert or update of role_title, role_id on public.profiles
  for each row execute function public.profiles_sync_role_id();

-- トリガー関数を直接呼ばせない（RLS からは呼ばれないので外してよい）
revoke execute on function public.profiles_sync_role_id() from public;
revoke execute on function public.profiles_sync_role_id() from anon;
revoke execute on function public.profiles_sync_role_id() from authenticated;

comment on function public.profiles_sync_role_id() is
  'profiles.role_title から role_id を必ず導出する（role_title が正）。roles に無い名前は 23503 で止める（2026-09-09 段0）';

-- 既存行を一度そろえる（本日 0件の不一致だが、トリガー導入の初期化として通す）
update public.profiles p
   set role_id = r.id
  from public.roles r
 where r.name = p.role_title
   and p.role_id is distinct from r.id;
