-- 「ログイン済みなら誰でも読み書きできる」ポリシーの是正
--
-- 【背景】
-- 下記4テーブルは cmd=ALL / 条件=true で作られており、ログインさえしていれば
-- 他人の分まで読み・書き・削除できる状態だった。
-- ポリシー名（admin_all_enc_days / user_own_enc_response）と中身が真逆になっていた
-- ＝名前を信用せず、必ず pg_policies の qual / with_check を見ること。
--
-- 【方針】
--   読み取り … その画面が実際に必要とする範囲まで絞る
--   書き込み … 管理画面からしか行わないので is_admin() に限定
--              （is_admin() = app_metadata.role = 'admin'。役職名では判定しない）
--
-- 通知処理（encouragement-notify）は service_role で動くのでRLSの影響を受けない。

-- ============================================================
-- ① app_settings（アプリ全体の設定の保管庫）
--    読み：ナビの表示判定・連絡板の送信権限・プッシュ案内バナーで全員が読む
--    書き：管理画面（管理者のみ）
-- ============================================================
drop policy if exists "allow_all" on public.app_settings;

create policy "app_settings_select_authenticated" on public.app_settings
  for select to authenticated
  using (true);

create policy "app_settings_insert_admin" on public.app_settings
  for insert to authenticated
  with check (public.is_admin());

create policy "app_settings_update_admin" on public.app_settings
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "app_settings_delete_admin" on public.app_settings
  for delete to authenticated
  using (public.is_admin());

-- ============================================================
-- ② paid_leave_encouragement_days（有給奨励日そのもの）
--    読み：本人が自分の未回答分を確認するのに必要。中身は日付と期限だけで
--          個人情報を含まないため、テーブルをまたぐ条件（相互参照事故の前例あり）は
--          あえて書かず全員読み取り可のままにする
--    書き：管理者のみ
-- ============================================================
drop policy if exists "admin_all_enc_days" on public.paid_leave_encouragement_days;

create policy "enc_days_select_authenticated" on public.paid_leave_encouragement_days
  for select to authenticated
  using (true);

create policy "enc_days_insert_admin" on public.paid_leave_encouragement_days
  for insert to authenticated
  with check (public.is_admin());

create policy "enc_days_update_admin" on public.paid_leave_encouragement_days
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "enc_days_delete_admin" on public.paid_leave_encouragement_days
  for delete to authenticated
  using (public.is_admin());

-- ============================================================
-- ③ paid_leave_encouragement_targets（誰が対象か）
--    読み：本人（画面側は必ず user_id = 自分 で取得している）＋管理者
--    書き：管理者のみ
-- ============================================================
drop policy if exists "admin_all_enc_targets" on public.paid_leave_encouragement_targets;

create policy "enc_targets_select_own_or_admin" on public.paid_leave_encouragement_targets
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy "enc_targets_insert_admin" on public.paid_leave_encouragement_targets
  for insert to authenticated
  with check (public.is_admin());

create policy "enc_targets_update_admin" on public.paid_leave_encouragement_targets
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "enc_targets_delete_admin" on public.paid_leave_encouragement_targets
  for delete to authenticated
  using (public.is_admin());

-- ============================================================
-- ④ paid_leave_encouragement_responses（回答）
--    読み：本人＋管理者
--    追加：本人が自分の回答を登録する（ホームのバナー・休暇申請ページ）＋管理者の代理入力
--    変更・削除：管理者のみ（本人が自分の回答を後から書き換える画面は存在しない）
-- ============================================================
drop policy if exists "user_own_enc_response" on public.paid_leave_encouragement_responses;

create policy "enc_responses_select_own_or_admin" on public.paid_leave_encouragement_responses
  for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

create policy "enc_responses_insert_own_or_admin" on public.paid_leave_encouragement_responses
  for insert to authenticated
  with check (user_id = auth.uid() or public.is_admin());

create policy "enc_responses_update_admin" on public.paid_leave_encouragement_responses
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "enc_responses_delete_admin" on public.paid_leave_encouragement_responses
  for delete to authenticated
  using (public.is_admin());
