-- ============================================================
-- 場所予約：「基本設定を使える役職」を、役職名ではなく role_id で持つ
--            （2026-09-10 ユーザー承認）
--
-- 何が問題だったか:
--   room_settings の 'basic_settings_roles' は**役職名のカンマ区切り**で、
--   関数の既定値にも '一般,リーダー,フロア責任者,マネージャー,社長,管理者' と
--   直書きされていた。
--   🚨 rename_role()（20260910010747）は profiles / faq_answer_targets /
--      overtime_*_rules / notification_settings まで書き換えるが、
--      **room_settings は触らない**（2026-09-10 実測）。
--   → 役職を1つ改名しただけで、その役職の人が「基本設定」を
--     **黙って**使えなくなる。2026-09-09 に本番で起きた事故と同じ形。
--
-- どう直すか:
--   一覧を role_id（UUID）で持つ。名前が変わっても id は変わらないので、
--   改名にも役職の新設にも耐える。
--   判定も profiles.role_id で行う（role_id は 20260909210044 で role_title に
--   揃え済み、20260909231618 のトリガーで今後もずれない）。
--
-- 🚨 適用前に必ず確認すること（0 でなければ流さない）:
--     select count(*) from profiles where role_id is null;
--   role_id が空の人がいると、その人だけ基本設定を使えなくなる。
--
-- 変えないもの:
--   ・システム管理者（app_metadata.role = 'admin'）は今までどおり常に可
--   ・雇用形態がパートの人は今までどおり不可（room_is_staff()）
--   ・古い 'basic_settings_roles' の行は**消さない**（ロールバック時の戻り値）
--
-- ロールバック手順:
--   20260829400000_room_customers.sql の 84 行目からの定義を流し直す
--   （'basic_settings_roles' の行はそのまま残してあるので、値も元に戻る）。
-- ============================================================

-- ------------------------------------------------------------
-- 1) いまの「名前の一覧」を「id の一覧」に写す
--    🚨 名前で引くのはこの1回だけ（以後は id で判定する）
--    設定行が無いときは、これまでの既定値（パート以外の全役職）を使う
-- ------------------------------------------------------------
insert into room_settings (key, value, updated_at)
select
  'basic_settings_role_ids',
  coalesce(
    (select string_agg(r.id::text, ',' order by r.sort_order)
       from roles r
      where r.name = any (
        string_to_array(
          coalesce((select value from room_settings where key = 'basic_settings_roles'),
                   '一般,リーダー,フロア責任者,マネージャー,社長,管理者'),
          ','))),
    ''),
  now()
where not exists (select 1 from room_settings where key = 'basic_settings_role_ids');

-- ------------------------------------------------------------
-- 2) 判定を id で行う
-- ------------------------------------------------------------
create or replace function room_can_use_basic_settings() returns boolean
language sql stable security definer set search_path = public as $$
  -- 🚨 coalesce で false に確定させる（NULL を返すと、呼び出し側の
  --    not 判定() が NULL になって権限チェックが素通りする）
  select coalesce(case
    when (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' then true
    when not room_is_staff() then false
    -- 設定そのものが無いときは「パートでなければ可」＝これまでの動きに倒す
    -- （急に誰も使えなくならないように。空文字＝「全部外した」とは区別する）
    when (select value from room_settings where key = 'basic_settings_role_ids') is null then true
    else exists (
      select 1 from profiles p
       where p.id = auth.uid()
         and p.role_id is not null
         and p.role_id::text = any (
           string_to_array(
             (select value from room_settings where key = 'basic_settings_role_ids'), ','))
    )
  end, false);
$$;

comment on function room_can_use_basic_settings() is
  '「基本設定」（年度更新・キャンセル待ち・お客様・一括入力・スタッフ・用途詳細）を使ってよいか。'
  'room_settings.basic_settings_role_ids（role_id のカンマ区切り）で決まる。'
  '🚨 役職名では判定しない（2026-09-10。改名で権限が壊れるため）';
