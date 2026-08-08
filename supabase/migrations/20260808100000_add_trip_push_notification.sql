-- 出張報告（到着・終了）のプッシュ通知設定を追加する。
-- これまで出張報告はサイト通知・メールのみで、プッシュには対応していなかった。
--
-- 🚨 push-dispatch は「設定行が無い event_key はON扱い」で送ってしまう。
-- そのため EVENT_MAP に追加する前に、必ずこの seed（enabled=false）を先に流すこと。
-- 止めたいときも、この行を false にするのが唯一のキルスイッチ。
--
-- プッシュはベル通知（notifications）のINSERTが入口なので、届く相手は
-- サイト通知の宛先と同じになる。ここの recipient は「追加でプッシュする役職」用で、
-- 出張報告では使わないため null にしておく。
insert into public.notification_settings (event_key, channel, enabled, recipient, subject, template)
values
  ('trip:report_arrival', 'push', false, null, null, null),
  ('trip:report_end',     'push', false, null, null, null)
on conflict (event_key, channel) do nothing;
