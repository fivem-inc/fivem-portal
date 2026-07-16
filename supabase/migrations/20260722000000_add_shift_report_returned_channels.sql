-- 勤務変更報告「差し戻し時」を受理時と同じ4チャンネル（Slack・メール・サイト通知・プッシュ）対応にする。
-- push行は既存（20260720100000でシード済み）のため、site/slack/emailを追加する。
--
-- site は既定ON：これまで画面から無条件にベル通知を入れていた挙動を維持するため。
-- （ベル通知＝プッシュ通知パイプラインの入口なので、siteをOFFにすると本人へのプッシュも止まる）
-- slack / email は受理時と同じく既定OFF。
--
-- site の subject（＝ベル通知の2行目）は null のまま：
-- 空欄のときは画面側が「種別　日付＋理由」を自動で組み立てる（従来の表示と同じ）。
insert into notification_settings (event_key, channel, enabled, recipient, subject, template) values
  ('shift_report:returned', 'site', true,
    '{"recipients":["applicant"]}',
    null,
    '勤務変更報告が差戻されました'),
  ('shift_report:returned', 'slack', false,
    '{"channels":[]}',
    null,
    E'🔴 *【勤務変更報告 / 差し戻し】*\n\n*報告者：* {{申請者名}}\n*種別：* {{種別}}\n*日付：* {{日付}}\n*理由：* {{差し戻し理由}}'),
  ('shift_report:returned', 'email', false,
    '{"recipients":["applicant"]}',
    '【ファイブM】勤務変更報告が差戻されました',
    E'{{申請者名}}さん\n\n勤務変更報告（{{種別}}・{{日付}}）が差戻されました。\n理由：{{差し戻し理由}}\n\n内容を修正して再提出してください。\n{{リンク}}')
on conflict (event_key, channel) do nothing;
