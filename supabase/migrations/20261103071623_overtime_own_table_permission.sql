-- 残業の［履歴・実績報告］（ご本人の分）の［カード｜表］の切り替えを、役職ごとに出し分ける（2026-11-03 ユーザー確定）
-- 最初はマネージャー・社長・管理者だけオン。管理画面「役職・機能権限」の「残業の履歴を表で見る（自分の分）」で変えられる。
-- 画面の出し分けだけ（DB の見張りは無い・読める行は今までどおり本人の分）
insert into public.feature_permissions (role_id, feature_key, enabled)
select r.id, 'overtime_own_table', coalesce(r.is_manager_plus, false)
  from public.roles r
 where not exists (select 1 from public.feature_permissions f where f.role_id = r.id and f.feature_key = 'overtime_own_table');
