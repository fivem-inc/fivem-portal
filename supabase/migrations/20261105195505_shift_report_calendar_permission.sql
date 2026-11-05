-- 勤務変更の履歴に「カレンダーの予定」（上長が勤怠カレンダーに入れた予定）を出し、［カード｜表］で見る（2026-11-05 ユーザー確定）
-- 最初はマネージャー・社長・管理者だけオン。マネージャーの方に試していただいたあと、管理画面「役職・機能権限」でパートの方をオンにすると公開。
-- 画面の出し分けだけ（DB の見張りは無い・読める行は今までどおり：ご本人は自分の予定、ほかの方の予定は attendance_input か管理者）
insert into public.feature_permissions (role_id, feature_key, enabled)
select r.id, 'shift_report_calendar', coalesce(r.is_manager_plus, false)
  from public.roles r
 where not exists (select 1 from public.feature_permissions f where f.role_id = r.id and f.feature_key = 'shift_report_calendar');
