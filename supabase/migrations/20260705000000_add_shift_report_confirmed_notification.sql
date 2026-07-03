-- 勤務変更申請「受理時」の通知設定を追加。
-- 既存の time_adjustment:registered（時間調整登録時）と同じ「役職＋グループ絞り込み」方式で、
-- 同じグループの該当役職者全員に一斉配信できるようにする。
insert into notification_settings (event_key, channel, enabled, recipient, subject, template) values
  ('shift_report:confirmed', 'site', true,
    '{"roles":["リーダー","マネージャー","管理者","社長"],"groupFilter":"same"}',
    null,
    E'⏰ {{申請者名}}さんの勤務変更申請（{{種別}}・{{日付}}）が受理されました'),
  ('shift_report:confirmed', 'slack', false,
    '{"channels":[]}',
    null,
    E'⏰ *勤務変更申請が受理されました*\n\n*申請者：* {{申請者名}}\n*種別：* {{種別}}\n*日付：* {{日付}}\n*勤務地：* {{勤務地}}'),
  ('shift_report:confirmed', 'email', false,
    null,
    '【ファイブM】勤務変更申請が受理されました',
    E'{{申請者名}}さんの勤務変更申請（{{種別}}・{{日付}}）が受理されました。')
on conflict (event_key, channel) do nothing;
