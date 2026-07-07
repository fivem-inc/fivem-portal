-- purchase_requestsのRLSで管理者(role_title='管理者')が他人の申請を閲覧できない不具合を修正
-- 原因：(auth.jwt() ->> 'role') は常に 'authenticated' を返す（Postgresセッションロール）ため、
-- カスタムのapp_metadata.roleとは一致しない。正しくは (auth.jwt() -> 'app_metadata' ->> 'role')
-- （2026-06-17に roles/feature_permissions で一度発見・修正済みの不具合と同一パターン）

drop policy if exists "pr_manager_plus_select" on public.purchase_requests;

create policy "pr_manager_plus_select" on public.purchase_requests
  for select using (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    or exists (select 1 from profiles where id = auth.uid() and role_title in ('マネージャー', '社長'))
  );

drop policy if exists "pr_admin_all" on public.purchase_requests;

create policy "pr_admin_all" on public.purchase_requests
  for all using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
