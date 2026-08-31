-- ============================================================
-- 場所予約：スタッフの追加・変更を社員にも開放する（2026-08-29 ユーザー確定）
--
-- 何をするものか:
--   room_staff（スタッフ）と room_staff_categories（担当できる区分）の
--   書き込みを、管理者だけ → 社員まで（パートは不可）に広げる。
--
-- なぜ:
--   スタッフの増減は日常業務で、そのたびに管理者を待つことになっていた。
--
-- 変えないもの（ユーザー確定）:
--   room_lesson_categories（レッスン区分）… 管理者のまま
--   room_campuses / room_floors（校・場所）… 管理者のまま
--   🚨 場所の同時予約件数(capacity)は二重予約の上限そのもので、
--      3→5 にすればその場所に5件入るようになる。予約全体の安全に
--      直結するため、日常的に触る設定とは分けておく。
--
-- 権限の判定:
--   20260829100000 で作った room_is_staff() を使う。
--   🚨 同じ条件を書き写さないこと。片方だけ直すと画面とサーバーが食い違う。
--
-- ロールバック手順:
--   drop policy if exists room_staff_write on room_staff;
--   create policy room_staff_write on room_staff for all to authenticated
--     using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
--     with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
--   （room_staff_categories も同じ形に戻す）
-- ============================================================

-- スタッフ本体
drop policy if exists room_staff_write on room_staff;
create policy room_staff_write on room_staff
  for all to authenticated
  using (room_is_staff())
  with check (room_is_staff());

-- 担当できる区分の割り当て。
-- 区分そのもの（room_lesson_categories）は管理者のままだが、
-- 「誰がどの区分を担当するか」はスタッフ設定と一体なので一緒に開放する
drop policy if exists room_staff_categories_write on room_staff_categories;
create policy room_staff_categories_write on room_staff_categories
  for all to authenticated
  using (room_is_staff())
  with check (room_is_staff());
