-- 残業・時間管理のSlack通知を追加する（2026-08-25）
--
-- これまで残業には slack の設定行を作っていなかった（「個人の勤怠情報を公開チャンネルに
-- 流さない」という判断）。専用チャンネル #17残業_調整_年休連絡用 ができたため方針を変更する。
--
-- 🚨 既定は全部 OFF・送信先チャンネルも未選択。管理画面でONにしたものだけ飛ぶ。
--    （プッシュ push-dispatch は「設定行が無い＝ON扱い」だが、Slackは各関数が
--      enabled を見るので「行が無い＝送らない」。逆なので混同しないこと）
--
-- 差し戻し（overtime:returned）と管理者修正（overtime:admin_edited）は対象外。
-- 差し戻しは本人へのやりとりなので共有チャンネルに流さない（ユーザー判断）。
insert into public.notification_settings (event_key, channel, enabled, recipient, subject, template) values
  ('overtime:new_request',       'slack', false, '{"channels":[]}', null, null),
  ('overtime:request_confirmed', 'slack', false, '{"channels":[]}', null, null),
  ('overtime:confirmed',         'slack', false, '{"channels":[]}', null, null),
  ('overtime:cancelled',         'slack', false, '{"channels":[]}', null, null),
  ('overtime:admin_cancelled',   'slack', false, '{"channels":[]}', null, null)
on conflict (event_key, channel) do nothing;

-- 勤務変更のSlack本文はコード側（Edge Function）で組み立てるようにしたので、
-- DBに残っていた古いテンプレートを外す。
-- 🚨 このテンプレートは「勤務変更申請／申請者：」のままだった＝2026-07-15 に
--    「申請→報告」へ言い換えたときの直し漏れ。しかも管理画面のSlack欄には本文の入力欄が無く、
--    画面からは一生直せない場所にあった（DBのテンプレートがコードより優先される作りだったため）。
update public.notification_settings
set template = null
where event_key in ('shift_report:confirmed', 'shift_report:returned')
  and channel = 'slack';
