-- 備品購入申請: Slack通知の送信先チャンネル・有効/無効を管理画面（通知設定タブ）から選択できるようにする
-- 対象は主要イベントのみ。意見提出ごとの通知（manager_opinion_submitted等）はSlack対象外（siteのみ）。
INSERT INTO notification_settings (event_key, channel, enabled, recipient, subject, template) VALUES
  ('purchase_request:submitted',           'slack', true, '{"channels":["leader"]}',            null, null),
  ('purchase_request:submitted_manager',   'slack', true, '{"channels":["manager"]}',            null, null),
  ('purchase_request:submitted_board',     'slack', true, '{"channels":["manager","president"]}', null, null),
  ('purchase_request:self_judgment_shared','slack', true, '{"channels":["manager"]}',            null, null),
  ('purchase_request:leader_approved',     'slack', true, '{"channels":["manager"]}',            null, null),
  ('purchase_request:manager_approved',    'slack', true, '{"channels":["accounting"]}',         null, null),
  ('purchase_request:board_all_approved',  'slack', true, '{"channels":["accounting"]}',         null, null),
  ('purchase_request:returned',            'slack', true, '{"channels":["leader","manager"]}',   null, null)
ON CONFLICT (event_key, channel) DO NOTHING;
