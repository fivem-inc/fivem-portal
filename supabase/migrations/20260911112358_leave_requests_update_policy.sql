-- 休暇申請の「書き換えてよい人」を、画面の出し分けと同じ顔ぶれに揃える
--   （2026-09-11 ユーザー承認。前セッションからの繰越「ログイン済みなら誰でも読み書き」の是正）
--
-- 【いまの状態（実測）】
--   UPDATE の許可は `update_admin`（using = is_leader_plus()）の1つだけ。
--   つまり **リーダー以上の11人が、誰の休暇申請でも書き換えられる**。
--   🚨 画面は `canApprove` で正しく出し分けているので普通に使う分には起きないが、
--      DBの側が緩い＝画面を通らない経路（APIを直接叩く等）では素通りする。
--
-- 【画面の出し分け（canApprove）はこうなっている】
--   ・管理者                                        … いつでも
--   ・pending        かつ approver_id  が自分       … 1人目の受理
--   ・step2_pending  かつ approver2_id が自分       … 2人目の受理
--   ・admin_approved かつ 社長                      … 最終受理
--   → **同じ顔ぶれ**を許可の条件にする。
--
-- 🚨 **申請者本人は入れない。** 本人が触る道は SECURITY DEFINER の専用処理
--    （cancel_own_leave / edit_own_leave）で、そちらが「承認前だけ」「自分の申請だけ」を
--    保証している。ここで本人に直接の書き込みを許すと、**本人が status を 'approved' に
--    書き換えられる**ことになる（いまより危なくなる）。
--
-- 【書き込んでいる場所を全部数えてから決めた（12か所）】
--   管理画面 5 ＋ AdminPanel 1 … 管理者          → is_admin() で通る
--   受理の画面 5              … 受理者          → approver_id / approver2_id で通る
--   再申請の自動取消 1        … 申請者本人      → 🚨 **いまも通っていない**（0件で失敗していた）
--                                                 画面を cancel_own_leave に直した（別コミット）
--   ＝ **この変更で仕事ができなくなる人はいない**。
--
-- 🚨 SELECT・INSERT・DELETE の許可は触っていない（見え方は1件も変わらない）。

drop policy if exists update_admin on public.leave_requests;

create policy update_admin on public.leave_requests
  for update
  using (
    approver_id  = auth.uid()                 -- 1人目の受理者
    or approver2_id = auth.uid()              -- 2人目の受理者
    or is_admin()                             -- 管理者（経理の受理もここ）
    or acts_as_is('president')                -- 社長（最終受理）
  );

comment on policy update_admin on public.leave_requests is
  '書き換えてよいのは、その申請の受理者（1人目・2人目）と管理者と社長だけ。画面の canApprove と同じ顔ぶれ。申請者本人は cancel_own_leave / edit_own_leave（SECURITY DEFINER）を通す';
