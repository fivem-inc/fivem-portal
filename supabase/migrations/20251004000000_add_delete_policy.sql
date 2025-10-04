-- 管理者が申請を削除できるRLSポリシーを追加
create policy "Admins can delete any expense."
  on expenses for delete
  using (auth.uid() in (select id from profiles where email = 'fivem.kyoto@gmail.com'));