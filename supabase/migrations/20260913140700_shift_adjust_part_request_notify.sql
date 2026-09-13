-- シフト調整：「出勤のお願い」の通知設定（手順7の後半）
--
-- 【なぜ行を入れるのか】
-- 🚨 管理画面（NotificationsTab）は `notification_settings` に**行があるチャンネルだけ**を出す。
--    行が無いと「**通知は飛ぶのに管理画面から止められない**」＝画面が嘘をつく。
--    （2026-09-11 の申請依頼リマインドでも同じ理由で必ず入れた）
-- 🚨 `push-dispatch` は `notification_settings` の push 行が無いと「送る」側に倒れる
--    （`pushEnabled.get(key) === false` のときだけ止める）。止められるようにするには行が要る。
--
-- 【宛先は本人固定なので recipient は使わない（null）】
--   「設定が無い＝全員に送る」の事故は起きない。送り先は出勤をお願いした相手だけ。
--
-- 【🚨 メールは既定 OFF】
--   パートにメールを送る運用が無い。既存の申請依頼（application_request:received）と同じ。

insert into notification_settings (event_key, channel, enabled, recipient, subject, template)
values
  ('shift_adjust:part_request', 'site',  true,  null, null,
   '📅 {{日付}}の出勤のお願いが届いています'),
  ('shift_adjust:part_request', 'push',  true,  null, null, null),
  ('shift_adjust:part_request', 'email', false, null,
   '出勤のお願い（{{日付}}）',
   '{{日付}} の出勤をお願いできないか、ご確認をお願いします。' || chr(10) || chr(10) || '{{リンク}}')
on conflict do nothing;

-- 🚨 site の template はいま使っていない（画面が `insertNotification` に文字を直接渡しているため）。
--    入れてあるのは、管理画面で文面を確かめられるようにするため。
--    🚨 `dispatchSiteNotification` に切り替えるときは **template が null だと通知が出ない**ので、
--       そのときはこの行の文面がそのまま使われることになる。
comment on table public.notification_settings is
  '通知の ON/OFF と文面。🚨 行が無いチャンネルは管理画面に出ない＝止められない。新しい通知を作ったら必ず行を入れること。';
