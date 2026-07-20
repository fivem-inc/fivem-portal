-- ========================================
-- 残業管理の管理者判定を app_metadata.role に修正
-- 当初 (auth.jwt() ->> 'role') = 'admin' で書いてしまい管理者と認識されず
-- weekly_shift_patterns 等へのINSERTがRLSで弾かれていた（42501）。
-- このアプリの管理者は app_metadata.role で判定するのが正（既存 fix_purchase_requests_admin_rls と同じ）。
-- ※ 20260724000000 本体は既に正しい書き方に修正済み。本ファイルは適用済みDBの後追い修正用。
-- ========================================
create or replace function has_feature_permission(p_feature text)
returns boolean
language sql stable security definer set search_path = public as $$
  select (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    or exists (
      select 1
      from profiles p
      join roles r
        on r.id = p.role_id
        or (p.role_id is null and r.name = p.role_title)
      join feature_permissions fp
        on fp.role_id = r.id and fp.feature_key = p_feature
      where p.id = auth.uid() and fp.enabled
    );
$$;

alter policy "patterns_admin_all" on weekly_shift_patterns
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

alter policy "calendar_admin_all" on company_calendar
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

alter policy "overtime_admin_all" on overtime_reports
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

alter policy "segments_admin_all" on overtime_report_segments
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

alter policy "overtime_settings_admin_all" on overtime_settings
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

alter policy "name_aliases_admin_all" on overtime_name_aliases
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
