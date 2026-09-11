-- ベル通知の絵文字を「権限管理の画面と同じアイコン」に揃える（2026-09-11 ユーザー確定）
--
-- きっかけ：勤怠の通知だけ文面が 🔴 で始まっており、**未読の印（赤い丸）と並んで
--   赤丸が2つ**に見えていた（ユーザー実機指摘）。ついでに全体がバラバラだったので揃える。
--
-- 🚨 割り当ての決め方：**管理画面「役職・機能権限」が機能ごとのアイコンを既に決めている**ので、
--    それに合わせた。こうすると「この絵文字＝この機能」がシステム全体で1つになり、
--    覚えることが増えない。新しいルールを発明していない。
--      📅 勤怠カレンダー ／ ⏰ 勤務変更報告 ／ 🕐 残業・時間管理 ／ 🌿 休暇 ／ 🔁 シフト調整の記録
--      🧾 備品購入・経費精算 ／ 🚃 交通費 ／ 📍 出張報告 ／ 💬 連絡板 ／ 🆘 安否 ／ 📩 申請の依頼 ／ 🔔 管理
-- 🚨 備品購入は**状態ごとに絵文字を変えていた**（✅承認 ↩️差戻し 💬意見 ⚠️否認 ℹ️共有）が、
--    ユーザー確定で**種類（🧾）に統一**した。ルールを1つにすることを優先した判断。
-- 🚨 **文面の言葉は1文字も変えていない**（先頭の絵文字を置き換え／追加しただけ）。
--    App.tsx が「お知らせ」「メッセージが届き」「リマインド」という**文字で連絡板かどうかを
--    判定している**ので、言葉を変えると通知の分類が壊れる。
-- 🚨 **メールの文面（47行）は触っていない**。今回はベルの見た目の話。
-- 🚨 **過去に作られた通知は変わらない**（文面は notifications に保存済みのため）。
--
-- 対象：channel='site' で文面がある33行のうち **28行**（残り5行は既に正しい）。
-- 同じ割り当ては client/src と supabase/functions のコードにも入れてある（同じ表を見ている）。
update public.notification_settings set template = '🔔 {{件名}}', updated_at = now()
 where event_key = 'admin:setup_alert' and channel = 'site';
update public.notification_settings set template = '📅 {{対象者名}}さんの{{種別}}が取消されました（{{日付}}）', updated_at = now()
 where event_key = 'attendance:cancelled' and channel = 'site';
update public.notification_settings set template = '📅 {{対象者名}}さんの{{種別}}が登録されました（{{日付}}）', updated_at = now()
 where event_key = 'attendance:registered' and channel = 'site';
update public.notification_settings set template = '🚃 {{申請者名}} が交通費を申請しました（{{金額}}円）', updated_at = now()
 where event_key = 'expense:new_request' and channel = 'site';
update public.notification_settings set template = '🌿 休暇申請がマネージャーに受理されました 「{{申請者名}}（{{日付}}）」', updated_at = now()
 where event_key = 'leave:approved_fyi' and channel = 'site';
update public.notification_settings set template = '🌿 休暇申請（{{休暇種別}}）の受理が取り消されました', updated_at = now()
 where event_key = 'leave:cancelled' and channel = 'site';
update public.notification_settings set template = '🌿 休暇申請がリーダーに受理されました（{{休暇種別}}）', updated_at = now()
 where event_key = 'leave:leader_approved' and channel = 'site';
update public.notification_settings set template = '🌿 休暇申請がマネージャーに受理されました', updated_at = now()
 where event_key = 'leave:manager_approved' and channel = 'site';
update public.notification_settings set template = '🌿 {{申請者名}} が {{休暇種別}} を申請しました', updated_at = now()
 where event_key = 'leave:new_request' and channel = 'site';
update public.notification_settings set template = '🌿 休暇申請が差し戻されました。申請履歴を確認してください。', updated_at = now()
 where event_key = 'leave:rejected' and channel = 'site';
update public.notification_settings set template = '🌿 {{元種別}}が差し戻され、{{新種別}}で再申請・受理済みです', updated_at = now()
 where event_key = 'leave:rejected_reapplied' and channel = 'site';
update public.notification_settings set template = '🌿 「{{元種別}}」が「{{新種別}}」に変更され、受理されました', updated_at = now()
 where event_key = 'leave:rejected_type_changed' and channel = 'site';
update public.notification_settings set template = '🕐 締め後申請の依頼は見送られました', updated_at = now()
 where event_key = 'overtime:grant_declined' and channel = 'site';
update public.notification_settings set template = '🕐 {{申請者名}}さんから締め後申請の許可依頼が届きました', updated_at = now()
 where event_key = 'overtime:grant_request' and channel = 'site';
update public.notification_settings set template = '🧾 「{{品目名}}」の申請が全員承認され、確定しました', updated_at = now()
 where event_key = 'purchase_request:board_all_approved' and channel = 'site';
update public.notification_settings set template = '🧾 「{{品目名}}」の申請に否認意見があります。全員回答後に話し合いが必要です', updated_at = now()
 where event_key = 'purchase_request:board_denial_present' and channel = 'site';
update public.notification_settings set template = '🧾 {{回答者名}}さんが「{{品目名}}」の申請に意見を提出しました', updated_at = now()
 where event_key = 'purchase_request:board_opinion_submitted' and channel = 'site';
update public.notification_settings set template = '🧾 {{投稿者名}}さんが「{{品目名}}」の申請に書き込みました', updated_at = now()
 where event_key = 'purchase_request:comment_added' and channel = 'site';
update public.notification_settings set template = '🧾 備品購入申請（{{品目名}}）が承認されました', updated_at = now()
 where event_key = 'purchase_request:leader_approved' and channel = 'site';
update public.notification_settings set template = '🧾 備品購入申請（{{品目名}}）が承認されました', updated_at = now()
 where event_key = 'purchase_request:manager_approved' and channel = 'site';
update public.notification_settings set template = '🧾 {{回答者名}}さんが「{{品目名}}」の申請に意見を提出しました', updated_at = now()
 where event_key = 'purchase_request:manager_opinion_submitted' and channel = 'site';
update public.notification_settings set template = '🧾 「{{品目名}}」の申請で全員の意見が出揃いました。最終決定をお願いします', updated_at = now()
 where event_key = 'purchase_request:manager_opinions_ready' and channel = 'site';
update public.notification_settings set template = '🧾 備品購入申請（{{品目名}}）が差し戻されました。理由をご確認のうえ修正して再申請してください', updated_at = now()
 where event_key = 'purchase_request:returned' and channel = 'site';
update public.notification_settings set template = '🧾 {{申請者名}}さんが自己判断で備品を購入します（共有）（{{品目名}}・¥{{金額}}）', updated_at = now()
 where event_key = 'purchase_request:self_judgment_shared' and channel = 'site';
update public.notification_settings set template = '⏰ 勤務変更報告が差戻されました', updated_at = now()
 where event_key = 'shift_report:returned' and channel = 'site';
update public.notification_settings set template = '📅 {{登録者名}}さんが{{日付}}に{{種別}}を登録しました。理由：{{理由}}', updated_at = now()
 where event_key = 'time_adjustment:registered' and channel = 'site';
update public.notification_settings set template = '📍 {{申請者名}} の出張到着報告が届きました', updated_at = now()
 where event_key = 'trip:report_arrival' and channel = 'site';
update public.notification_settings set template = '📍 {{申請者名}} の出張終了報告が届きました', updated_at = now()
 where event_key = 'trip:report_end' and channel = 'site';
