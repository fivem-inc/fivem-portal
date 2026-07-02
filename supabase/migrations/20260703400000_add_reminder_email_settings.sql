-- リマインド3種（有給奨励日未回答・定期リマインド・連絡板締切未読）の
-- メール通知ON/OFFを管理画面から設定できるようにする

insert into notification_settings (event_key, channel, enabled, recipient, subject, template) values
  ('reminder:encouragement', 'email', false, null, '【ファイブM】有給奨励日の回答期限のお知らせ',
    '有給奨励日（{{対象日}}）の回答期限（{{期限}}）が近づいています。\nまだ回答されていない場合は、アプリからご回答ください。'),
  ('reminder:scheduled', 'email', false, null, '【ファイブM】{{タイトル}}',
    '{{本文}}'),
  ('reminder:unread', 'email', false, null, '【ファイブM連絡板】締切が近い未読の連絡があります',
    '締切が近い連絡板の投稿があります。\n下記のリンクからご確認ください。\n{{リンク}}')
on conflict (event_key, channel) do nothing;
