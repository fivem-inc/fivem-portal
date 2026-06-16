-- RLS ポリシーの修正
-- (auth.jwt() ->> 'role') は常に 'authenticated' を返すため、
-- app_metadata 内の role を正しく参照する形に変更

drop policy if exists "roles_admin_all" on public.roles;
drop policy if exists "feature_permissions_admin_all" on public.feature_permissions;

create policy "roles_admin_all" on public.roles
  for all to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

create policy "feature_permissions_admin_all" on public.feature_permissions
  for all to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
