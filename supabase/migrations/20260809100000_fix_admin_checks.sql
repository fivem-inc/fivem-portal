-- 管理者の判定方法を正しい書き方に統一する（2026-08-09）
--
-- 直す対象は2種類。どちらも「今は動いているが、将来まとめて壊れる」時限爆弾。
--
-- ① メールアドレスの直書き（expenses / profiles）
--    「fivem.kyoto@gmail.com という人だけ操作できる」と書かれていた。
--    → メールアドレスを変えた瞬間に、誰も交通費・スタッフ情報を管理できなくなる。
--      しかもエラーは出ず「0件」に見えるだけなので気づけない。
--    → 他機能と同じ「管理者という役割」で判定する形に統一する。
--
-- ② auth.jwt() ->> 'role' の誤記（leave_requests / shift_reports / shift_report_history /
--    attendance_exceptions の計6ポリシー）
--    JWTのトップレベルの role は常に 'authenticated' なので、この条件は永久に false。
--    同じ式に role_title の OR があるため今は動いているが、管理者の役職名を変えた瞬間に
--    休暇申請・勤務変更・勤怠カレンダーがまとめて見えなくなる。
--    → 正しい `(auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'` に直す。
--
-- 🚨 管理者判定は必ず app_metadata 経由で書くこと（このプロジェクトで3回踏んでいる）。

-- ────────────────────────────────
-- ① メールアドレス直書きをやめる
-- ────────────────────────────────

-- 交通費：管理者は全申請を操作できる
drop policy if exists "管理者は全申請を操作できる" on public.expenses;
create policy "管理者は全申請を操作できる" on public.expenses
  for all to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- スタッフ情報：メール直書きの管理者ポリシー3本を1本にまとめる。
--   ・「管理者は全プロフィールを見られる」(ALL/info@five-m.com) … 使われていない旧アドレス
--   ・「管理者は全プロフィールを見られる2」(SELECT) … 下の全員読み取りポリシーと重複
--   ・「管理者は全操作できる」(ALL/fivem.kyoto@gmail.com) … これを正しい判定で作り直す
-- ※ 閲覧は別途 "authenticated users can read all profiles"(true) があるので影響なし
drop policy if exists "管理者は全プロフィールを見られる" on public.profiles;
drop policy if exists "管理者は全プロフィールを見られる2" on public.profiles;
drop policy if exists "管理者は全操作できる" on public.profiles;
create policy "管理者は全操作できる" on public.profiles
  for all to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- ────────────────────────────────
-- ② auth.jwt() ->> 'role' の誤記を直す（条件の中身は変えない）
-- ────────────────────────────────

drop policy if exists "select_admin" on public.leave_requests;
create policy "select_admin" on public.leave_requests
  for select to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    or exists (
      select 1 from public.profiles
      where profiles.id = auth.uid()
        and profiles.role_title = any (array['リーダー', 'マネージャー', '社長', '管理者'])
    )
  );

drop policy if exists "approver_select" on public.shift_reports;
create policy "approver_select" on public.shift_reports
  for select to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    or exists (
      select 1 from public.profiles
      where profiles.id = auth.uid()
        and profiles.role_title = any (array['リーダー', 'マネージャー', 'フロア責任者', '社長', '管理者'])
    )
  );

drop policy if exists "approver_delete" on public.shift_reports;
create policy "approver_delete" on public.shift_reports
  for delete to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    or exists (
      select 1 from public.profiles
      where profiles.id = auth.uid()
        and profiles.role_title = any (array['リーダー', 'マネージャー', 'フロア責任者', '社長', '管理者'])
    )
  );

drop policy if exists "reviewer_confirm" on public.shift_reports;
create policy "reviewer_confirm" on public.shift_reports
  for update to authenticated
  using (
    reviewer_id = auth.uid()
    and (
      (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
      or exists (
        select 1 from public.profiles
        where profiles.id = auth.uid()
          and profiles.role_title = any (array['リーダー', 'マネージャー', 'フロア責任者', '社長', '管理者'])
      )
    )
  );

drop policy if exists "history_select" on public.shift_report_history;
create policy "history_select" on public.shift_report_history
  for select to authenticated
  using (
    changed_by = auth.uid()
    or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    or exists (
      select 1 from public.profiles
      where profiles.id = auth.uid()
        and profiles.role_title = any (array['リーダー', 'マネージャー', 'フロア責任者', '社長', '管理者'])
    )
  );

drop policy if exists "Approvers can manage attendance_exceptions" on public.attendance_exceptions;
create policy "Approvers can manage attendance_exceptions" on public.attendance_exceptions
  for all to authenticated
  using (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    or exists (
      select 1 from public.profiles
      where profiles.id = auth.uid()
        and profiles.role_title = any (array['リーダー', 'マネージャー', '社長', '管理者'])
    )
  );
