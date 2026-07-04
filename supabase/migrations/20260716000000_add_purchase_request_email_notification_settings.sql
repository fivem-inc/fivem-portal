-- 備品購入申請: メール通知の送信先・件名・本文を管理画面（通知設定タブ）から設定できるようにする
-- 対象は主要イベントのみ（Slack通知と同じ8イベント）。意見提出ごとの通知はメール対象外（siteのみ）。
insert into notification_settings (event_key, channel, enabled, recipient, subject, template) values
  ('purchase_request:submitted',            'email', true, '{"recipients":["leader"]}',
    '【ファイブM】備品購入申請が届いています',
    E'{{申請者名}}さんから備品購入申請が届いています。\n品目名：{{品目名}}\n金額：{{金額}}円\nアプリからご確認ください。'),
  ('purchase_request:submitted_manager',    'email', true, '{"recipients":["approver"]}',
    '【ファイブM】備品購入申請の審議依頼が届いています',
    E'{{申請者名}}さんから備品購入申請の審議依頼が届いています。\n品目名：{{品目名}}\n金額：{{金額}}円\nアプリからご確認ください。'),
  ('purchase_request:submitted_board',      'email', true, '{"recipients":["approver"]}',
    '【ファイブM】備品購入申請の全員承認依頼が届いています',
    E'{{申請者名}}さんから備品購入申請の全員承認依頼が届いています。\n品目名：{{品目名}}\n金額：{{金額}}円\nアプリからご確認ください。'),
  ('purchase_request:self_judgment_shared', 'email', true, '{"recipients":["approver"]}',
    '【ファイブM】備品購入申請が自己判断・共有されました',
    E'{{申請者名}}さんの備品購入申請が自己判断（共有のみ）で処理されました。\n品目名：{{品目名}}\n金額：{{金額}}円\nアプリからご確認ください。'),
  ('purchase_request:leader_approved',      'email', true, '{"recipients":["applicant"]}',
    '【ファイブM】備品購入申請が承認されました',
    E'{{申請者名}}さんの備品購入申請（{{品目名}}・{{金額}}円）がリーダーにより承認されました。'),
  ('purchase_request:manager_approved',     'email', true, '{"recipients":["applicant"]}',
    '【ファイブM】備品購入申請が承認されました',
    E'{{申請者名}}さんの備品購入申請（{{品目名}}・{{金額}}円）がマネージャーにより承認されました。'),
  ('purchase_request:board_all_approved',   'email', true, '{"recipients":["applicant"]}',
    '【ファイブM】備品購入申請が全員承認されました',
    E'{{申請者名}}さんの備品購入申請（{{品目名}}・{{金額}}円）が全員承認され、自動確定しました。'),
  ('purchase_request:returned',             'email', true, '{"recipients":["applicant"]}',
    '【ファイブM】備品購入申請が差し戻されました',
    E'{{申請者名}}さんの備品購入申請（{{品目名}}・{{金額}}円）が差し戻されました。\nアプリから差し戻し理由をご確認ください。')
on conflict (event_key, channel) do nothing;
