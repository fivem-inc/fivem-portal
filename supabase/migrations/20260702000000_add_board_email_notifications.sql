-- 連絡板（お知らせ・個人DM・グループメッセージ）のメール通知設定を追加
-- 本文は載せず「届いたことの通知＋リンク」のみ（本文が漏れないようにするため）

insert into notification_settings (event_key, channel, enabled, recipient, subject, template) values
  ('board:notice',        'email', false, null, '【ファイブM連絡板】{{件名}}',
    '{{送信者名}}さんからお知らせが届きました。\n下記のリンクからご確認ください。\n{{リンク}}'),
  ('board:dm_message',    'email', false, null, '【ファイブM連絡板】メッセージが届きました',
    '{{送信者名}}さんからメッセージが届きました。\n下記のリンクからご確認ください。\n{{リンク}}'),
  ('board:group_message', 'email', false, null, '【ファイブM連絡板】{{グループ名}}に新着メッセージ',
    '{{グループ名}}に{{送信者名}}さんからメッセージが届きました。\n下記のリンクからご確認ください。\n{{リンク}}')
on conflict (event_key, channel) do nothing;
