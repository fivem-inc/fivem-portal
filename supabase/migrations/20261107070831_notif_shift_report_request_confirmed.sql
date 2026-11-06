-- ============================================================
-- 2026-11-07  通知設定に「事前申請が受理されたとき（ご本人へ）」（勤務変更の事前申請・ユーザー確定 案1）
-- ============================================================
-- ・受理のベル（ご本人へ・スマホなし）は、これまで通知設定を見ずに必ず作っていた。
--   勤務変更のページの確認ページと管理画面の勤務変更のタブが、この行（site）を見てから作る（lib/notificationDispatch の advanceAcceptedBellOn）
-- ・🚨 最初はオン（今までと同じ動き）。行が無いときも「作る」側に倒す
-- ・push の行は作らない（このお知らせはスマホに出さない＝今までどおり）

insert into notification_settings (event_key, channel, enabled)
select 'shift_report:request_confirmed', 'site', true
 where not exists (select 1 from notification_settings
                    where event_key = 'shift_report:request_confirmed' and channel = 'site');
-- 戻すとき：delete from notification_settings where event_key = 'shift_report:request_confirmed';
