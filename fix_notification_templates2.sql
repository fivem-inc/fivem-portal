-- 差し戻しSlackはOFF（現状未実装）
update notification_settings set enabled = false
where event_key = 'leave:rejected' and channel = 'slack';

-- 差し戻しサイト通知テンプレート修正
update notification_settings set template = '休暇申請が差し戻されました', subject = '{{差し戻し理由}}'
where event_key = 'leave:rejected' and channel = 'site';

-- 差し戻し追加パターン（種別変更受理）
insert into notification_settings (event_key, channel, enabled, recipient, subject, template)
values
  ('leave:rejected_type_changed', 'site', true, 'applicant', null, '「{{元種別}}」が「{{新種別}}」に変更され、受理されました'),
  ('leave:rejected_reapplied',    'site', true, 'applicant', null, '{{元種別}}が差し戻され、{{新種別}}で再申請・受理済みです')
on conflict (event_key, channel) do nothing;

-- 出張報告はSlack手動送信のため全チャンネルOFF
update notification_settings set enabled = false
where event_key = 'trip:report_end' and channel = 'slack';
