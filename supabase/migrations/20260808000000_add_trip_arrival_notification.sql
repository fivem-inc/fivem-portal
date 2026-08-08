-- 出張報告の「到着報告時」の通知設定を追加する。
-- これまで到着報告には通知が一切なく、終了報告だけが通知されていた。
--
-- 🚨 notification_settings に行が無いイベントは管理画面に表示されないため、必ずseedする。
-- 既定はOFF（終了報告と同じ）。ONにするか・誰に届けるかは管理画面から設定する。
-- Slackは対象外（出張のSlackは申請者が報告画面でチャンネルを手動選択する仕組みのため）。
--
-- recipient の形式：
--   recipients   … 宛先（applicant/leader/manager/president）
--   groupFilter  … same=申請者と同じ所属チームのみ / all=全員
--   orgWideRoles … 絞り込みの対象外にする役職（この役職はチームに関係なく全員に届く）
insert into public.notification_settings (event_key, channel, enabled, recipient, subject, template)
values
  ('trip:report_arrival', 'site', false,
   '{"recipients":["manager"],"groupFilter":"same","orgWideRoles":["社長","管理者"]}',
   null,
   '{{申請者名}} の出張到着報告が届きました'),
  ('trip:report_arrival', 'email', false,
   '{"recipients":["manager"],"groupFilter":"same","orgWideRoles":["社長","管理者"]}',
   '出張到着報告が届きました',
   E'{{申請者名}} さんの出張到着報告が届きました。')
on conflict (event_key, channel) do nothing;
