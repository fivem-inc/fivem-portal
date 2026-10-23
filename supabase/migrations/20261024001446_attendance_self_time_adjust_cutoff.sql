-- 社員本人の「時間調整（調整遅出・調整早退）」を、データベースの側でも区切りの日（10/16）より前の日だけにする（2026-10-24 ユーザー指示）
--
-- 10/16 から時間調整は残業申請で出す決まり（lib/overtimeUnify・app_settings 'overtime_unify_cutoff'）。
-- 画面（休暇申請のページの「時間調整」）は 10/13 から区切りの日以降を止めているが、
-- データベースの決まり「Users can insert own time adjustments」は日付の上限が無く、画面を通さなければ今も入れられた。
-- → 区切りの日より前の日だけにする（区切りの日が読めないときは今までどおり）。ほかの条件（本人・本人が作成・2種類・今日以降）は変えない
-- 🚨 管理者・勤怠入力の権限がある人（「Approvers can manage attendance_exceptions」）は変わらない＝上長は今までどおり勤怠カレンダーに入れられる

drop policy if exists "Users can insert own time adjustments" on public.attendance_exceptions;
create policy "Users can insert own time adjustments" on public.attendance_exceptions
  for insert to public
  with check (
    user_id = auth.uid()
    and created_by = auth.uid()
    and type = any (array['late_start'::text, 'early_end'::text])
    and date >= current_date
    and date < coalesce(
      (select (s.value #>> '{}')::date from public.app_settings s where s.key = 'overtime_unify_cutoff'),
      'infinity'::date)
  );
