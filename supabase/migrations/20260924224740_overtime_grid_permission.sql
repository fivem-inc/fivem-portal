-- ============================================================
-- 2026-09-24  残業の「表でまとめて入力」を「権限管理」で出し分ける（最初はマネージャーだけ）
-- ============================================================
-- 2026-09-24 ユーザー確定：まずマネージャーにだけ出す（西村先生の相談から。docs/計画-残業の表入力.md）。
-- 以後の変更は管理画面（権限管理 → 勤怠・時間 →「残業の表入力」）で行う。
--
-- 🚨 役職名を直に書かない。`roles.acts_as = 'manager'`（マネージャーの立場）で入れる。
--    役職の改名に耐えるため（2026-09-09 に役職を改名して壊れた事故がある）。
-- 🚨 「マネージャー以上」（is_manager_plus＝社長・管理者も含む）ではない。前例の overtime_memo とは違うので真似しないこと。
-- 🚨 管理者はコード側で常に true（realIsAdmin）。行は揃えるために入れておく。
-- 🚨 画面の入口を出し分けるだけ。送る申請は1件フォームと同じ許可（RLS）を通るので、DB側の締め付けは変わらない。
--
-- ロールバック手順:
--   delete from feature_permissions where feature_key = 'overtime_grid';

insert into public.feature_permissions (role_id, feature_key, enabled)
select r.id, 'overtime_grid', coalesce(r.acts_as = 'manager', false)
  from public.roles r
on conflict (role_id, feature_key) do nothing;

-- 確認用:
--   select r.name, fp.enabled
--     from public.feature_permissions fp
--     join public.roles r on r.id = fp.role_id
--    where fp.feature_key = 'overtime_grid'
--    order by r.sort_order;
