-- 修正依頼・取消依頼のプッシュ通知設定（キルスイッチ）
--
-- 背景：correction_requests のRPC（submit/resolve/decline）は event_key
--   'correction:new' / 'correction:resolved' / 'correction:declined'
-- でベル通知を作るが、push-dispatch の EVENT_MAP に未登録だったため
-- push_queue に積まれても全件 skipped ＝プッシュが1件も飛んでいなかった。
-- 今回 EVENT_MAP に3キーを追加してプッシュを有効化する。
--
-- push-dispatch は「設定行が無いイベントはON扱い」（fail-open）のため、
-- この seed 行が唯一のキルスイッチになる。止めたいときは：
--   update notification_settings set enabled = false
--   where event_key like 'correction:%' and channel = 'push';
--
-- ※このイベントは管理画面「通知設定」タブのカテゴリに未登録のため、
--   画面からはON/OFFできない（必要になったら NotificationsTab にカテゴリを足す）。
-- 宛先はRPC側で固定（new=管理者全員／resolved・declined=依頼した本人）なので recipient は null。

insert into notification_settings (event_key, channel, enabled, recipient, subject, template) values
  ('correction:new',      'push', true, null, null, null),
  ('correction:resolved', 'push', true, null, null, null),
  ('correction:declined', 'push', true, null, null, null)
on conflict (event_key, channel) do nothing;
