-- ========================================
-- 全員のシフト予定 閲覧ページ（shift_pattern_directory）
--
-- リーダー以上（初期: 社長/管理者/マネージャー/リーダー）が、全員（パート含む）の
-- 通常シフト（weekly_shift_patterns）を人ごとに閲覧できるようにする。
-- アクセス可否は feature_permissions 方式（管理画面でON/OFF可能）。
--
-- ※ このページはシフト"予定"の閲覧のみ。残業データとは無関係。
--   残業の役職階層フィルタ（20260729000000）とは別系統。
-- ========================================

begin;

-- 1) 新しい機能キーの権限を seed
--    初期ON = 社長 / 管理者 / マネージャー / リーダー（＝リーダー以上）
--    それ以外（フロア責任者・一般・パート）は OFF。管理画面で後から変更可。
do $$
declare
  r record;
begin
  for r in select id, name from public.roles loop
    insert into public.feature_permissions (role_id, feature_key, enabled)
    values (
      r.id,
      'shift_pattern_directory',
      r.name in ('社長', '管理者', 'マネージャー', 'リーダー')
    )
    on conflict (role_id, feature_key) do nothing;
  end loop;
end $$;

-- 2) weekly_shift_patterns: directory 権限者は全員分を参照できる
--    （既存 patterns_select_own / patterns_select_summary / patterns_admin_all は据え置き）
drop policy if exists "patterns_select_directory" on weekly_shift_patterns;
create policy "patterns_select_directory" on weekly_shift_patterns
  for select using (has_feature_permission('shift_pattern_directory'));

commit;

-- ========================================
-- ロールバック
-- ========================================
-- begin;
-- drop policy if exists "patterns_select_directory" on weekly_shift_patterns;
-- delete from public.feature_permissions where feature_key = 'shift_pattern_directory';
-- commit;
