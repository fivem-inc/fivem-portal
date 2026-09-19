-- 退職者の申請期間・2段目の手順3-1（2026-09-19・設計書 §8-7）
-- 退職者に開ける22表の既存ポリシーのうち「to public」のものを「to authenticated」に付け替える。
-- 🚨 条件（using / with check）は変えない。役割の欄だけ。在籍者（authenticated）の見え方・書ける範囲は変わらない。
-- ねらい：退職者専用の役割 retiree に、在籍者向けの広い条件（部下の申請が読める等）や retiree が実行できない関数が効かないようにする。
-- 元に戻すとき：同じ表・同じポリシー名で `alter policy … to public`（対象の一覧は下の配列）
do $$
declare
  r record;
  tbls text[] := array[
    'profiles','roles','feature_permissions','app_settings','master_options','company_calendar','notification_settings','weekly_shift_patterns',
    'overtime_calendar_choice_rules','leader_assignments','expenses','overtime_reports','overtime_report_segments','overtime_report_history',
    'overtime_submission_grants','overtime_submission_grant_requests','overtime_plan_items','shift_reports','shift_report_history',
    'application_requests','correction_requests','notifications'];
begin
  for r in
    select tablename, policyname from pg_policies
     where schemaname = 'public' and tablename = any (tbls) and roles = '{public}'::name[]
  loop
    execute format('alter policy %I on public.%I to authenticated', r.policyname, r.tablename);
  end loop;
end $$;
