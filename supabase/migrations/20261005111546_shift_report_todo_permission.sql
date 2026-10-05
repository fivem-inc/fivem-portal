-- ============================================================
-- 2026-10-05  勤務変更の「カレンダーの予定の一覧」を「権限管理」で出し分ける（最初はマネージャー・社長・管理者だけ）
-- ============================================================
-- ✅ ユーザー確定（2026-10-05）：まずマネージャーで確かめ、パートの方へのお知らせの文面ができてからパートをオンにする。
--   以後の変更は管理画面（権限管理 → 勤怠・時間 →「勤務変更：カレンダーの予定の一覧」）で行う。
-- ・マネージャー以上（is_manager_plus＝マネージャー・社長・管理者）をオン。パートはオフ
-- 🚨 役職名を直に書かない（属性で入れる・2026-09-09 に役職の改名で壊れた事故がある）
-- 🚨 画面の出し分けだけ。読み書きの許可（RLS）は変わらない
--
-- ロールバック手順:
--   delete from feature_permissions where feature_key = 'shift_report_todo';

insert into public.feature_permissions (role_id, feature_key, enabled)
select r.id, 'shift_report_todo', coalesce(r.is_manager_plus, false)
  from public.roles r
on conflict (role_id, feature_key) do nothing;

-- 確認用:
--   select r.name, fp.enabled from public.feature_permissions fp join public.roles r on r.id = fp.role_id
--    where fp.feature_key = 'shift_report_todo' order by r.sort_order;
