-- 定期リマインドの設定を、管理者以外は書き換えられないようにする
--
-- 【問題】ポリシー名は「管理者のみ操作可」なのに、実際の条件は using(true) / with check(true)。
--   ＝ログインしていれば誰でも定期リマインドの設定を追加・変更・削除できる状態だった。
--   画面上はそんな操作をさせていないが、DBの許可としては全開。
--   設定を消されるとリマインドが飛ばなくなるが、エラーは出ないので誰も気づけない
--   （「今月来てないな」と思うだけ）。2026-08-10 に profiles で塞いだ穴と同じ型。
--
-- 【対応】閲覧は全員可のまま／追加・変更・削除は管理者のみに限定する。
--   閲覧を残す理由：今後スタッフ側のバナーがこのテーブルから件名・本文を読むため。
--   管理者判定はプロジェクトの決まりどおり app_metadata 経由で書く
--   （profiles.role_title は表示ラベル用なので使わない）。

drop policy if exists "管理者のみ操作可" on public.board_scheduled_reminders;

create policy "reminders_select_all"
  on public.board_scheduled_reminders
  for select
  to authenticated
  using (true);

create policy "reminders_admin_write"
  on public.board_scheduled_reminders
  for all
  to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
