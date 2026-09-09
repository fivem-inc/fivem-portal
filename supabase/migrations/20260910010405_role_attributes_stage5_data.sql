-- 役職の属性化・段5（役職名で保存されていたデータを role_id で照合する）。
--
-- 【対象】faq_answer_targets（FAQの対象役職）／overtime_threshold_rules／overtime_calendar_choice_rules（残業の役職ルール）
-- 【やり方】role_id 列を足し、role_title から必ず導出するトリガーを付ける（profiles と同じ方式・段0）。
--   ・画面はこれまでどおり role_title（役職名）を書く → トリガーが role_id を埋める
--   ・照合（DBの関数・画面）は role_id で行う → 改名しても対象がずれない
--   ・role_title は表示用に残す。改名時は rename_role がまとめて書き換える（段6）
-- 🚨 notification_settings の JSON（roles / ccRoles / orgWideRoles）は役職名のまま。
--    読む側（resolve_role_recipients / role_ids_for）が名前・role_id・コードのどれでも解釈でき、
--    改名時は rename_role が JSON の中の名前も書き換える（段6）。30行を変換して管理画面まで作り直すより安全。

-- ========================================
-- 1) 役職名 → role_id を必ず導出する共通トリガー関数
-- ========================================
create or replace function public.role_rules_sync_role_id()
returns trigger language plpgsql security definer set search_path = public as $$
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
end $$;
revoke execute on function public.role_rules_sync_role_id() from public;
revoke execute on function public.role_rules_sync_role_id() from anon;
revoke execute on function public.role_rules_sync_role_id() from authenticated;

-- ========================================
-- 2) 3表に role_id を足し、既存行を埋め、トリガーを付ける
-- ========================================
alter table public.faq_answer_targets          add column if not exists role_id uuid references public.roles(id) on delete set null;
alter table public.overtime_threshold_rules    add column if not exists role_id uuid references public.roles(id) on delete set null;
alter table public.overtime_calendar_choice_rules add column if not exists role_id uuid references public.roles(id) on delete set null;

update public.faq_answer_targets t set role_id = r.id from public.roles r where r.name = t.role_title and t.role_id is distinct from r.id;
update public.overtime_threshold_rules t set role_id = r.id from public.roles r where r.name = t.role_title and t.role_id is distinct from r.id;
update public.overtime_calendar_choice_rules t set role_id = r.id from public.roles r where r.name = t.role_title and t.role_id is distinct from r.id;

drop trigger if exists trg_faq_answer_targets_sync_role_id on public.faq_answer_targets;
create trigger trg_faq_answer_targets_sync_role_id
  before insert or update of role_title, role_id on public.faq_answer_targets
  for each row execute function public.role_rules_sync_role_id();
drop trigger if exists trg_overtime_threshold_rules_sync_role_id on public.overtime_threshold_rules;
create trigger trg_overtime_threshold_rules_sync_role_id
  before insert or update of role_title, role_id on public.overtime_threshold_rules
  for each row execute function public.role_rules_sync_role_id();
drop trigger if exists trg_overtime_calendar_choice_rules_sync_role_id on public.overtime_calendar_choice_rules;
create trigger trg_overtime_calendar_choice_rules_sync_role_id
  before insert or update of role_title, role_id on public.overtime_calendar_choice_rules
  for each row execute function public.role_rules_sync_role_id();

create index if not exists idx_faq_answer_targets_role_id on public.faq_answer_targets (role_id);

comment on column public.faq_answer_targets.role_id is '対象役職（role_title から自動導出・照合はこちらで行う。2026-09-10 段5）';
comment on column public.overtime_threshold_rules.role_id is '対象役職（role_title から自動導出・照合はこちらで行う。2026-09-10 段5）';
comment on column public.overtime_calendar_choice_rules.role_id is '対象役職（role_title から自動導出・照合はこちらで行う。2026-09-10 段5）';

-- ========================================
-- 3) DB の判定関数を role_id 照合に（本番の実定義から起こし、該当行だけ差し替え）
-- ========================================
create or replace function public.overtime_can_choose_calendar(p_user uuid)
 returns boolean language sql stable security definer set search_path to 'public' as $function$
  select coalesce(
    (select r.enabled
       from overtime_calendar_choice_rules r
      where r.user_id = p_user),
    (select r.enabled
       from overtime_calendar_choice_rules r
       join profiles p on p.role_id = r.role_id
      where p.id = p_user and r.role_id is not null),
    false
  );
$function$;

create or replace function public.overtime_threshold_for(p_user uuid)
 returns integer language plpgsql stable security definer set search_path to 'public' as $function$
declare
  v_rule    record;
  v_role_id uuid;
  v_default integer;
begin
  -- 個人の指定が最優先
  select threshold_minutes, excluded into v_rule
  from overtime_threshold_rules where user_id = p_user;
  if found then
    if v_rule.excluded then return null; end if;
    return v_rule.threshold_minutes;
  end if;

  -- 次に役職（🚨 役職名ではなく role_id で照合・2026-09-10 段5）
  select role_id into v_role_id from profiles where id = p_user;
  if v_role_id is not null then
    select threshold_minutes, excluded into v_rule
    from overtime_threshold_rules where role_id = v_role_id;
    if found then
      if v_rule.excluded then return null; end if;
      return v_rule.threshold_minutes;
    end if;
  end if;

  -- 最後に全員の既定
  select threshold_minutes into v_default from overtime_settings where id = 1;
  return coalesce(v_default, 600);
end;
$function$;
