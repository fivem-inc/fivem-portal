-- 残業「受理まち」催促の第2弾：勤務日が来る前に1回だけ上長へ知らせる
--
-- 【背景】
-- 20260825100000 で入れた催促は「勤務日を過ぎた未受理」が対象で、毎日送る。
-- しかし事前申請の目的は「勤務日の前に上長が把握すること」なので、
-- 勤務日を過ぎてからの催促は終わったことの後追いにしかならない。
--   例）8/20の残業を8/18に申請 → 上長が忘れる → 催促は8/21から（8/20はもう終わっている）
-- そこで「勤務日より前」の未受理にも、申請から24時間たった時点で1回だけ催促する。
--
-- 【1回だけにする仕組み】
-- overtime_reports.advance_remind_sent_at に送った日時を書き、次からは対象外にする。
-- 🚨 通知そのものの有無では判定しない。
--    ベル通知は既読30日で自動削除されるうえ、毎日の pile-up 掃除でも消えるため、
--    「通知が無い＝まだ送っていない」とは言えず、何度も送ってしまう。
--
-- 🚨 event_key は毎日送る分（overtime:pending_review）と分ける。
--    同じキーにすると、毎日の掃除（dismissed=false を全削除）でこの1回きりの催促まで
--    翌日に消えてしまい、上長が1日ベルを見ないだけで見落とす。

alter table public.overtime_reports
  add column if not exists advance_remind_sent_at timestamptz;

comment on column public.overtime_reports.advance_remind_sent_at is
  '「勤務日前の受理まち」催促を上長へ送った日時。1回だけ送るための記録';

-- 通知設定（管理画面でON/OFF）。site/push はフラグ用（本文はEdge・push-dispatchが生成）。
-- メールは既定OFF（毎日ではなく1回だけだが、まずはベルとプッシュで様子を見る）
insert into notification_settings (event_key, channel, enabled, recipient, subject, template) values
  ('overtime:pending_review_advance', 'site',  true,  null, null, null),
  ('overtime:pending_review_advance', 'push',  true,  null, null, null),
  ('overtime:pending_review_advance', 'email', false, null, '残業申請の受理のお願い（勤務日が近づいています）',
     E'勤務日が近い残業申請のうち、受理がまだのものが {{件数}} 件あります。\n対象：{{内訳}}\n\n下記から内容を確認して受理してください。\n{{リンク}}')
on conflict (event_key, channel) do nothing;

-- 止めたいとき（プッシュだけ）:
--   update notification_settings set enabled=false where event_key='overtime:pending_review_advance' and channel='push';
