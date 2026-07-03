-- 各種メール通知テンプレートにリンク（{{リンク}}）を追記
-- 対象：勤務変更申請の受理・時間調整の登録・有給奨励日の未回答リマインド・休暇申請（新規/受理/差し戻し）
-- 送信元Edge Function／dispatchEmail呼び出し側は既にvarsに{{リンク}}を渡すよう対応済み

update notification_settings set template = template || E'\n\n下記のリンクからご確認ください。\n{{リンク}}'
where channel = 'email'
  and event_key in (
    'shift_report:confirmed',
    'time_adjustment:registered',
    'reminder:encouragement',
    'leave:new_request',
    'leave:leader_approved',
    'leave:manager_approved',
    'leave:rejected'
  )
  and template not like '%{{リンク}}%';
