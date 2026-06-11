-- 既存ポリシーを削除して読み取りは全員、書き込みは管理者のみに変更
drop policy if exists "管理者のみ参照・編集可能" on notification_settings;

-- 全認証済みユーザーが読み取り可能（shouldSendが機能するために必要）
create policy "認証済みユーザーは参照可能" on notification_settings
  for select using (auth.uid() is not null);

-- 書き込みは管理者・社長のみ
create policy "管理者のみ編集可能" on notification_settings
  for all using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid()
      and profiles.role_title in ('管理者', '社長')
    )
  )
  with check (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid()
      and profiles.role_title in ('管理者', '社長')
    )
  );
