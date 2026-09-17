-- ============================================================
-- 2026-09-18  残業のメモを「権限管理」で出し分ける（最初はマネージャー以上）
-- ============================================================
-- 2026-09-17 ユーザー確定：残業申請のメモは、まず**マネージャー以上**にだけ出す。
-- 以後の変更は管理画面（権限管理 → 勤怠・時間 →「残業のメモ」）で行う。
--
-- 🚨 役職名を直に書かない。`roles.is_manager_plus`（マネージャー・社長・管理者）で入れる。
--    役職の改名に耐えるため（2026-09-09 に役職を改名して壊れた事故がある）。
-- 🚨 管理者はコード側で常に true（realIsAdmin）。行は揃えるために入れておく。
--
-- ロールバック手順:
--   delete from feature_permissions where feature_key = 'overtime_memo';

insert into public.feature_permissions (role_id, feature_key, enabled)
select r.id, 'overtime_memo', coalesce(r.is_manager_plus, false)
  from public.roles r
on conflict (role_id, feature_key) do nothing;

-- 確認用:
--   select r.name, fp.enabled
--     from public.feature_permissions fp
--     join public.roles r on r.id = fp.role_id
--    where fp.feature_key = 'overtime_memo'
--    order by r.sort_order;
