-- 社内お知らせに「表示期間」と「リマインド」を追加。
-- 列追加のみ・既存データ非破壊（既存行は starts_at/ends_at=null＝即時表示・無期限のまま）。
-- 冪等（add column if not exists）なので再実行安全。
--
-- starts_at / ends_at    : 表示期間（timestamptz, JST基準で保存。ends_at は終了日の23:59:59）
-- notify_on_create_push  : 作成した瞬間にプッシュ通知で知らせる
-- notify_on_create_email : 作成した瞬間にメールで知らせる（全員へ）
-- remind_in_app          : 終了日が近づいたらアプリ内でバナー再表示
-- remind_push            : 終了日が近づいたらプッシュ通知（announcement-remind cron が送信）
-- remind_email           : 終了日が近づいたらメール（全員へ）
-- remind_days_before     : 終了日の何日前からリマインドするか
-- remind_frequency       : 'once'=期間中1回だけ / 'daily'=期間中は毎日
-- remind_last_sent_on    : リマインドを最後に送ったJST日付（二重送信防止）
alter table public.announcements
  add column if not exists starts_at timestamptz,
  add column if not exists ends_at timestamptz,
  add column if not exists notify_on_create_push boolean not null default false,
  add column if not exists notify_on_create_email boolean not null default false,
  add column if not exists remind_in_app boolean not null default false,
  add column if not exists remind_push boolean not null default false,
  add column if not exists remind_email boolean not null default false,
  add column if not exists remind_days_before int not null default 3,
  add column if not exists remind_frequency text not null default 'once',
  add column if not exists remind_last_sent_on date;

-- 管理画面「通知設定」からお知らせ系プッシュをON/OFFできるよう 'push' チャンネル行をシード
-- （無ければON）。push-dispatch の EVENT_MAP と対応。
--   announcement:new    … 作成時のプッシュ
--   announcement:remind … リマインドのプッシュ
insert into notification_settings (event_key, channel, enabled)
select v.event_key, 'push', true
from (values ('announcement:new'), ('announcement:remind')) as v(event_key)
where not exists (
  select 1 from notification_settings s
  where s.event_key = v.event_key and s.channel = 'push'
);

-- ロールバック:
--   alter table public.announcements
--     drop column if exists starts_at, drop column if exists ends_at,
--     drop column if exists notify_on_create_push, drop column if exists notify_on_create_email,
--     drop column if exists remind_in_app, drop column if exists remind_push,
--     drop column if exists remind_email,
--     drop column if exists remind_days_before, drop column if exists remind_frequency,
--     drop column if exists remind_last_sent_on;
--   delete from notification_settings where event_key in ('announcement:new','announcement:remind') and channel='push';
