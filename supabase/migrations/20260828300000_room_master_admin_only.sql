-- ============================================================
-- 場所予約：マスタの書き換えを管理者だけに絞る（2026-08-28）
--
-- なぜ直すか:
--   最初の2本では room_* すべてを「ログイン済みなら全員が読み書き」にしていた。
--   予約(room_bookings)はそれでよいが、マスタ（校・場所・スタッフ・レッスン区分）まで
--   全員が書き換えられるのは緩すぎる。画面では管理者にしか設定ボタンを出していないが、
--   RLSが緩いままだと API を直接叩けば誰でも変更できてしまう。
--   例えば room_floors.capacity を書き換えられると、二重予約の上限が崩れる。
--
-- 方針:
--   読み取り … ログイン済みの全員（予約画面が場所名・スタッフ名を出すために必要）
--   書き込み … 管理者だけ
--
-- 🚨 管理者判定は必ず (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' と書く。
--    (auth.jwt() ->> 'role') = 'admin' は常に false になり、
--    このリポジトリでは過去に2回それで全員が保存できなくなっている。
--    クライアント側の判定（hooks/useAuth.ts の user.app_metadata.role）とも同じ意味になる。
--
-- room_bookings と room_recurrences は変更しない（全スタッフが予約を入れるため）。
--
-- ロールバック手順:
--   各テーブルで下記 4ポリシーを drop し、20260828100000 / 20260828200000 の
--   「for all to authenticated using (true) with check (true)」を作り直す。
-- ============================================================

-- 共通の形：select は全員、insert/update/delete は管理者だけ。
-- （for all の1本にまとめず select を分けるのは、読み取りを絶対に止めないため。
--   ここを1本にすると、判定を間違えたときに予約画面ごと真っ白になる）

-- ---- 校 ----
drop policy if exists room_campuses_all    on room_campuses;
drop policy if exists room_campuses_select on room_campuses;
drop policy if exists room_campuses_write  on room_campuses;
create policy room_campuses_select on room_campuses
  for select to authenticated using (true);
create policy room_campuses_write on room_campuses
  for all to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- ---- 場所（フロア）----
drop policy if exists room_floors_all    on room_floors;
drop policy if exists room_floors_select on room_floors;
drop policy if exists room_floors_write  on room_floors;
create policy room_floors_select on room_floors
  for select to authenticated using (true);
create policy room_floors_write on room_floors
  for all to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- ---- レッスン区分 ----
drop policy if exists room_lesson_categories_all    on room_lesson_categories;
drop policy if exists room_lesson_categories_select on room_lesson_categories;
drop policy if exists room_lesson_categories_write  on room_lesson_categories;
create policy room_lesson_categories_select on room_lesson_categories
  for select to authenticated using (true);
create policy room_lesson_categories_write on room_lesson_categories
  for all to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- ---- スタッフ ----
drop policy if exists room_staff_all    on room_staff;
drop policy if exists room_staff_select on room_staff;
drop policy if exists room_staff_write  on room_staff;
create policy room_staff_select on room_staff
  for select to authenticated using (true);
create policy room_staff_write on room_staff
  for all to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- ---- スタッフの担当区分 ----
drop policy if exists room_staff_categories_all    on room_staff_categories;
drop policy if exists room_staff_categories_select on room_staff_categories;
drop policy if exists room_staff_categories_write  on room_staff_categories;
create policy room_staff_categories_select on room_staff_categories
  for select to authenticated using (true);
create policy room_staff_categories_write on room_staff_categories
  for all to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
