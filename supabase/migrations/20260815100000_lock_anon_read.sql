-- ============================================================
-- 未ログイン（anon）から社内データが読めていた穴を塞ぐ
-- ============================================================
--
-- 【何が起きていたか】
-- 下記6テーブルのポリシーが USING (true) で、かつ対象が「TO public」だった。
-- Postgres の public は anon（未ログイン）を含むため、ログインしていない相手でも読めていた。
-- Supabase は既定で anon にテーブルのSELECT権限を配るので、RLSだけが唯一の防壁だった。
--
-- 本番のREST APIに anon キーで問い合わせて実測（読み取りのみ）：
--   app_settings                      … 9件 読めた
--   paid_leave_encouragement_responses … 50件 読めた（職員の有給奨励日の回答）
--   faq_topics / profiles              … 0件（TO authenticated なので正しく守られていた）
--
-- 【なぜ今直すか】
-- お客様向けFAQを会社ホームページに載せると、anon キーを目にする人が桁違いに増える。
-- 鍵を広く配る前に塞ぐ。
--
-- 【この変更で何が変わるか】
-- 対象を TO public → TO authenticated に変えるだけ。条件（USING / WITH CHECK）は一切変えない。
-- ＝ ログイン済みの人の見え方・できる操作は今までと完全に同じ。未ログインだけが弾かれる。
--
-- 🚨 ログイン前にこの6テーブルを読んでいる画面が無いことをコードで確認済み
--    （SignIn.tsx / ResetPassword.tsx / AuthContext.tsx に問い合わせ無し）
-- 🚨 Edge Function は service_role で動き RLS を通らないため影響なし
--
-- ⚠️ この修正は「未ログインを弾く」ところまで。
--    「ログイン済みなら誰でも読み書きできてしまう」問題（例：user_own_enc_response という
--    名前なのに実体が USING(true)）は別に残っている。挙動が変わるため別途対応する。
--    ポリシー名を信用せず必ず qual を見ること（2026-08-10 profiles・2026-08-13 定期リマインドと同型）。

-- ============================================================
-- 1) app_settings（通知バナー設定・カレンダー連携先・連絡板のCC設定など）
-- ============================================================
drop policy if exists "allow_all" on public.app_settings;
create policy "allow_all"
  on public.app_settings for all to authenticated
  using (true) with check (true);

-- ============================================================
-- 2) leave_approvals（誰が誰の休暇を受理したか）
-- ============================================================
drop policy if exists "関係者は閲覧可能" on public.leave_approvals;
create policy "関係者は閲覧可能"
  on public.leave_approvals for select to authenticated
  using (true);

-- ============================================================
-- 3) master_options（校・区分などの選択肢マスタ）
-- ============================================================
drop policy if exists "全員が読める" on public.master_options;
create policy "全員が読める"
  on public.master_options for select to authenticated
  using (true);

-- ============================================================
-- 4〜6) 有給奨励日（対象者・回答＝職員の個人情報）
-- ============================================================
-- ⚠️ 元の定義は WITH CHECK が無い（FOR ALL では USING が書き込み側にも使われる）。
--    ここでも WITH CHECK を書かずに元の挙動をそのまま保つ。
drop policy if exists "admin_all_enc_days" on public.paid_leave_encouragement_days;
create policy "admin_all_enc_days"
  on public.paid_leave_encouragement_days for all to authenticated
  using (true);

drop policy if exists "user_own_enc_response" on public.paid_leave_encouragement_responses;
create policy "user_own_enc_response"
  on public.paid_leave_encouragement_responses for all to authenticated
  using (true);

drop policy if exists "admin_all_enc_targets" on public.paid_leave_encouragement_targets;
create policy "admin_all_enc_targets"
  on public.paid_leave_encouragement_targets for all to authenticated
  using (true);
