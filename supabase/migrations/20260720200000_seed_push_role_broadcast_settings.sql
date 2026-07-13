-- 一斉通知系イベント（宛先を役職で選ぶタイプ）のプッシュ設定をシード。
-- これらはpush-dispatchパイプラインではなく、各Edge Functionが
-- 'push'チャンネルのrecipient（役職）を解決して直接send-pushする。
-- （ベル通知の宛先とは別に、プッシュだけ別の役職に送れるようにするため）

INSERT INTO notification_settings (event_key, channel, enabled, recipient)
VALUES
  -- 勤務変更 受理時：勤務に関わるためリーダー〜社長・同グループに通知
  ('shift_report:confirmed', 'push', true,
   '{"roles":["リーダー","マネージャー","管理者","社長"],"groupFilter":"same"}'),
  -- 時間調整 登録時：同上
  ('time_adjustment:registered', 'push', true,
   '{"roles":["リーダー","マネージャー","管理者","社長"],"groupFilter":"same"}'),
  -- 立替精算 記録時：当面は社長のみ（必要ならマネージャー・リーダーを追加）
  ('purchase:reimbursement_recorded', 'push', true,
   '{"roles":["社長"]}')
ON CONFLICT DO NOTHING;
