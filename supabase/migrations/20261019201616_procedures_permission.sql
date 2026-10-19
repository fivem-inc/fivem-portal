-- ============================================================
-- 2026-10-19  上のナビの「📋 手続き」（入社・退職の手続き /retire）を「権限管理」で出し分ける
-- ============================================================
-- ✅ ユーザー確定（2026-10-19・案1）：マネージャー以上の役職の中で、出す・出さないを選べるようにする。
--   初めは今と同じ（マネージャー以上の役職＝マネージャー・社長・管理者をオン）。以後は管理画面（権限管理 → その他 →「手続き（入社・退職）」）で変える。
-- 🚨 画面の出し分けだけ。中身の読み書きの許可（RLS の is_manager_plus()）は変わらない
--    → マネージャー以上でない役職は画面でオンにできない（FeaturePermissionsTab の managerPlusOnly・useAuth の canProcedures）
-- 🚨 役職名を直に書かない（属性で入れる）
--
-- ロールバック手順:
--   delete from feature_permissions where feature_key = 'procedures';

insert into public.feature_permissions (role_id, feature_key, enabled)
select r.id, 'procedures', coalesce(r.is_manager_plus, false)
  from public.roles r
on conflict (role_id, feature_key) do nothing;

-- 確認用:
--   select r.name, r.is_manager_plus, fp.enabled from public.feature_permissions fp join public.roles r on r.id = fp.role_id
--    where fp.feature_key = 'procedures' order by r.sort_order;
