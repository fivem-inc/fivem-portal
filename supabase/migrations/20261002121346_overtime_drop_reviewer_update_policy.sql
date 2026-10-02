-- 残業：受理する人が申請を直接書き換えられる許可（overtime_update_reviewer）を消す（2026-10-02 ユーザー承認）
--
-- 穴：申請先（reviewer_id）になっている人は、RLS の UPDATE 許可で、その申請の中身（時間・種類・本人など）を
--     条件なしに書き換えられた。確定済み（confirmed）の申請も書き換えられた（2026-10-02 本番で実測：書き換え 1件通った）。
--     画面を通さず直接 DB を操作する知識があれば、自分が申請先の他人の残業を書き換えられる状態だった。
-- 使っている所は無い（2026-10-02 確認）：
--   ・受理・差し戻し・取消は Edge Function overtime-approve が管理用の鍵（service_role＝RLS を通らない）で書く
--   ・画面の直接の書き換えは「本人の修正」（overtime_update_own）と管理画面（overtime_admin_all）だけ
--   ・ほかの Edge Function（gcal-sync・remind-*・send-overtime-slack）も管理用の鍵。呼ぶ人の権限で書き換える DB の関数は0
-- 本番で試して取り消した結果（2026-10-02）：
--   消す前：受理する人の書き換え 通る（受理済みの事前申請・確定済みとも）
--   消した後：受理する人の書き換え 止まる（0件）／受理する人が読む 今までどおり／本人の修正 通る／管理者 通る／service_role 通る

drop policy if exists overtime_update_reviewer on public.overtime_reports;
