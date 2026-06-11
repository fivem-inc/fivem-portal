update notification_settings set template = '🔔 *【休暇申請 / 新規】*
*申請先：* {{承認者名}}（{{承認者役職}}）'
where event_key = 'leave:new_request' and channel = 'slack';

update notification_settings set template = '✅ *【休暇申請 / 確認①】*
*確認先：* {{次承認者名}}（マネージャー）
*受理者：* {{承認者名}}（{{承認者役職}}）'
where event_key = 'leave:leader_approved' and channel = 'slack';

update notification_settings set template = '✅ *【休暇申請 / 確認②】*
*受理者：* {{承認者名}}（マネージャー）'
where event_key = 'leave:manager_approved' and channel = 'slack';

update notification_settings set template = '休暇申請がマネージャーに受理されました', subject = '種別：{{休暇種別}}'
where event_key = 'leave:manager_approved' and channel = 'site';

update notification_settings set template = '🆕 *【新しい交通費申請】*

*申請者:* {{申請者名}}
*申請日:* {{申請日}}
*申請内容:* {{申請内容}}
*項目数:* {{項目数}}件'
where event_key = 'expense:new_request' and channel = 'slack';
