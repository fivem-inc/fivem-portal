-- 残業・時間管理の通知を管理画面「通知設定」から編集できるようにする seed
--
-- 背景：残業の承認フロー系（申請・受理・差し戻し・取消・管理者修正）は notifications への
--       直INSERTだけで、notification_settings に行が無かった。そのため
--         ・管理画面に項目自体が出ない（ON/OFF不可）
--         ・push-dispatch は「行が無いイベントはON扱い」だが EVENT_MAP にキーが無く skipped
--           → スマホプッシュが一切飛んでいない
--         ・メールは未配線
--       という状態だった。
--
-- ⚠️ 実行順序：このSQLを先に実行してから push-dispatch をデプロイすること。
--    push行を作ることが唯一のキルスイッチ（行が無い＝ON扱いで止められない）。
--    ロールバックも Edge の再デプロイではなく
--      update notification_settings set enabled=false where event_key like 'overtime:%' and channel='push';
--    が第一手。
--
-- 既定値：site=ON（現状ベル通知が出ているので挙動維持）／push=ON（今回から届き始める）／
--         email=OFF（新規イベントのメールは既定OFFという慣習に合わせる）
-- Slack行は作らない（残業＝個人の勤怠情報。公開チャンネルに流さない。行が無ければ画面にも出ない）
--
-- ベル通知(site)の本文はシステム固定のため subject/template は NULL のままにする
--（管理画面側で site の本文編集欄を非表示にしている）

insert into notification_settings (event_key, channel, enabled, recipient, subject, template) values
  -- 申請・実績報告が届いた時 → 確認をお願いする人へ
  ('overtime:new_request', 'site',  true,  '{"recipients":["approver"]}', null, null),
  ('overtime:new_request', 'push',  true,  '{"recipients":["approver"]}', null, null),
  ('overtime:new_request', 'email', false, '{"recipients":["approver"]}',
     '残業・時間調整の申請が届きました',
     E'{{申請者名}}さんから残業・時間調整の申請が届きました。\n対象日：{{日付}}\n時間：{{時間}}\n\n下記から内容をご確認ください。\n{{リンク}}'),

  -- 事前申請を受理した時 → 申請した本人へ
  ('overtime:request_confirmed', 'site',  true,  '{"recipients":["applicant"]}', null, null),
  ('overtime:request_confirmed', 'push',  true,  '{"recipients":["applicant"]}', null, null),
  ('overtime:request_confirmed', 'email', false, '{"recipients":["applicant"]}',
     '事前申請が受理されました',
     E'{{日付}} の事前申請が受理されました。\n時間：{{時間}}\n\n勤務が終わったら、実績の報告をお願いします。\n{{リンク}}'),

  -- 実績を確認した時 → 報告した本人へ
  ('overtime:confirmed', 'site',  true,  '{"recipients":["applicant"]}', null, null),
  ('overtime:confirmed', 'push',  true,  '{"recipients":["applicant"]}', null, null),
  ('overtime:confirmed', 'email', false, '{"recipients":["applicant"]}',
     '実績が確認されました',
     E'{{日付}} の実績が確認されました。\n時間：{{時間}}\n\nこの内容で確定します。\n{{リンク}}'),

  -- 差し戻した時 → 申請した本人へ
  ('overtime:returned', 'site',  true,  '{"recipients":["applicant"]}', null, null),
  ('overtime:returned', 'push',  true,  '{"recipients":["applicant"]}', null, null),
  ('overtime:returned', 'email', false, '{"recipients":["applicant"]}',
     '残業・時間調整の申請が差し戻されました',
     E'{{日付}} の申請が差し戻されました。\n理由：{{差し戻し理由}}\n\n内容を直して、もう一度お送りください。\n{{リンク}}'),

  -- 本人が取り消した時 → 確認をお願いする人へ
  ('overtime:cancelled', 'site',  true,  '{"recipients":["approver"]}', null, null),
  ('overtime:cancelled', 'push',  true,  '{"recipients":["approver"]}', null, null),
  ('overtime:cancelled', 'email', false, '{"recipients":["approver"]}',
     '残業・時間調整の申請が取り消されました',
     E'{{申請者名}}さんが {{日付}} の申請を取り消しました。\n\n{{リンク}}'),

  -- 管理者が取り消した時 → 申請した本人へ
  ('overtime:admin_cancelled', 'site',  true,  '{"recipients":["applicant"]}', null, null),
  ('overtime:admin_cancelled', 'push',  true,  '{"recipients":["applicant"]}', null, null),
  ('overtime:admin_cancelled', 'email', false, '{"recipients":["applicant"]}',
     '残業・時間調整の申請が取り消されました',
     E'管理者が {{日付}} の申請を取り消しました。\n\nご不明な点は管理者にお問い合わせください。\n{{リンク}}'),

  -- 管理者が内容を修正した時 → 修正された本人へ
  ('overtime:admin_edited', 'site',  true,  '{"recipients":["applicant"]}', null, null),
  ('overtime:admin_edited', 'push',  true,  '{"recipients":["applicant"]}', null, null),
  ('overtime:admin_edited', 'email', false, '{"recipients":["applicant"]}',
     '残業・時間調整の内容が修正されました',
     E'管理者が {{日付}} の内容を修正しました。\n{{種別}}\n\n{{リンク}}')
on conflict (event_key, channel) do nothing;

-- 既存バグ修正：メール本文の改行が「\n」の2文字のままDBに入っている行を実改行に直す。
-- （20260731010000 が E'...' ではなく通常の '...' で書かれていたため。CLAUDE.md 2026-07-04 の再発）
-- ※ LIKE はバックスラッシュをエスケープ文字として解釈するため position() で判定する
update notification_settings
   set template = replace(template, '\n', chr(10))
 where channel = 'email'
   and event_key like 'overtime%'
   and position('\n' in template) > 0;
