create table if not exists notification_settings (
  id uuid primary key default gen_random_uuid(),
  event_key text not null,
  channel text not null,
  enabled boolean default true,
  recipient text,
  subject text,
  template text,
  updated_at timestamptz default now(),
  unique(event_key, channel)
);

create index if not exists idx_notification_settings_enabled
  on notification_settings(event_key, channel)
  where enabled = true;

alter table notification_settings enable row level security;

create policy "管理者のみ参照・編集可能" on notification_settings
  for all using (
    exists (
      select 1 from profiles
      where profiles.id = auth.uid()
      and profiles.role_title in ('管理者', '社長')
    )
  );

insert into notification_settings (event_key, channel, enabled, recipient, subject, template) values
  ('leave:new_request',       'slack', true,  '#休暇申請',  null,              '{{申請者名}} が {{休暇種別}} を申請しました（{{申請日数}}日）'),
  ('leave:new_request',       'email', false, 'leader',     '【休暇申請】{{申請者名}}', '{{申請者名}} さんが {{休暇種別}} を申請しました。\n申請日数：{{申請日数}}日\nご確認をお願いします。'),
  ('leave:new_request',       'site',  false, 'leader',     null,              '{{申請者名}} が {{休暇種別}} を申請しました'),
  ('leave:leader_approved',   'slack', true,  '#休暇申請',  null,              '{{承認者名}}（リーダー）が {{申請者名}} の休暇申請を受理し、マネージャーへ送りました'),
  ('leave:leader_approved',   'email', false, 'manager',    '【受理】休暇申請がマネージャーへ送られました', '{{申請者名}} の {{休暇種別}} 申請がリーダー受理されました。\nご確認をお願いします。'),
  ('leave:leader_approved',   'site',  false, 'applicant',  null,              '休暇申請がリーダーに受理されました（{{休暇種別}}）'),
  ('leave:manager_approved',  'slack', true,  '#休暇申請',  null,              '{{承認者名}}（マネージャー）が {{申請者名}} の休暇申請を受理しました'),
  ('leave:manager_approved',  'email', false, 'applicant',  '【受理】休暇申請が受理されました', '{{申請者名}} さん\n\n{{休暇種別}}（{{申請日数}}日）がマネージャーに受理されました。'),
  ('leave:manager_approved',  'site',  true,  'applicant',  null,              '休暇申請がマネージャーに受理されました（{{休暇種別}}）'),
  ('leave:rejected',          'slack', false, '#休暇申請',  null,              '{{申請者名}} の休暇申請が差し戻されました。理由：{{差し戻し理由}}'),
  ('leave:rejected',          'email', false, 'applicant',  '【差し戻し】休暇申請が差し戻されました', '{{申請者名}} さん\n\n{{休暇種別}} の申請が差し戻されました。\n理由：{{差し戻し理由}}'),
  ('leave:rejected',          'site',  true,  'applicant',  null,              '休暇申請が差し戻されました。理由：{{差し戻し理由}}'),
  ('expense:new_request',     'slack', true,  '#経費申請',  null,              '{{申請者名}} が交通費 {{金額}}円 を申請しました'),
  ('expense:new_request',     'email', false, 'approver',   '【交通費申請】{{申請者名}}', '{{申請者名}} が交通費 {{金額}}円 を申請しました。'),
  ('expense:new_request',     'site',  false, 'approver',   null,              '{{申請者名}} が交通費を申請しました（{{金額}}円）'),
  ('trip:report_end',         'slack', true,  '#出張報告',  null,              '{{申請者名}} の出張が終了しました'),
  ('trip:report_end',         'email', false, 'manager',    '【出張終了】{{申請者名}}', '{{申請者名}} の出張が終了しました。'),
  ('trip:report_end',         'site',  false, 'manager',    null,              '{{申請者名}} の出張終了報告が届きました')
on conflict (event_key, channel) do nothing;
