-- 社内FAQ：回答を出す相手（対象）の振り分けと、本文の訂正
-- 2026-08-22 ユーザーと1問ずつ確認して決定（全37問を精査）。
--
-- 【対象の考え方】その機能を使う人に合わせる。
--   パート以外＝一般・フロア責任者・リーダー・マネージャー・社長・管理者
--   リーダー以上／マネージャー以上／パート＋マネージャー以上
-- 🚨 対象を指定すると、指定していない役職の人には質問ごと見えなくなる（回答が空になるのではない）。
--    管理者・社長も例外ではない（faq.ts の matchesViewer は役職の一致だけを見る）。

-- ① 回答を出す相手（既存を消してから入れ直す）
-- 有給休暇を取りたいときは → 一般・フロア責任者・リーダー・マネージャー・社長・管理者
delete from public.faq_answer_targets where answer_id = 'ced7df7c-e9e5-4b31-aece-f042db2f5d3c';
insert into public.faq_answer_targets (answer_id, role_title) values
  ('ced7df7c-e9e5-4b31-aece-f042db2f5d3c', '一般'),
  ('ced7df7c-e9e5-4b31-aece-f042db2f5d3c', 'フロア責任者'),
  ('ced7df7c-e9e5-4b31-aece-f042db2f5d3c', 'リーダー'),
  ('ced7df7c-e9e5-4b31-aece-f042db2f5d3c', 'マネージャー'),
  ('ced7df7c-e9e5-4b31-aece-f042db2f5d3c', '社長'),
  ('ced7df7c-e9e5-4b31-aece-f042db2f5d3c', '管理者');

-- 休暇申請は誰がどの順番で受理する → 一般・フロア責任者・リーダー・マネージャー・社長・管理者
delete from public.faq_answer_targets where answer_id = '0ed12d96-ba68-4c5e-be12-5e2826d05f5e';
insert into public.faq_answer_targets (answer_id, role_title) values
  ('0ed12d96-ba68-4c5e-be12-5e2826d05f5e', '一般'),
  ('0ed12d96-ba68-4c5e-be12-5e2826d05f5e', 'フロア責任者'),
  ('0ed12d96-ba68-4c5e-be12-5e2826d05f5e', 'リーダー'),
  ('0ed12d96-ba68-4c5e-be12-5e2826d05f5e', 'マネージャー'),
  ('0ed12d96-ba68-4c5e-be12-5e2826d05f5e', '社長'),
  ('0ed12d96-ba68-4c5e-be12-5e2826d05f5e', '管理者');

-- 調整休の振替休日と時間外調整休 → 一般・フロア責任者・リーダー・マネージャー・社長・管理者
delete from public.faq_answer_targets where answer_id = '7b29507f-b4d2-419f-a831-1d9c9207afe3';
insert into public.faq_answer_targets (answer_id, role_title) values
  ('7b29507f-b4d2-419f-a831-1d9c9207afe3', '一般'),
  ('7b29507f-b4d2-419f-a831-1d9c9207afe3', 'フロア責任者'),
  ('7b29507f-b4d2-419f-a831-1d9c9207afe3', 'リーダー'),
  ('7b29507f-b4d2-419f-a831-1d9c9207afe3', 'マネージャー'),
  ('7b29507f-b4d2-419f-a831-1d9c9207afe3', '社長'),
  ('7b29507f-b4d2-419f-a831-1d9c9207afe3', '管理者');

-- 出した休暇申請を修正・取消したい → 一般・フロア責任者・リーダー・マネージャー・社長・管理者
delete from public.faq_answer_targets where answer_id = '3ae4b31a-82d5-4066-adef-18b152c8e772';
insert into public.faq_answer_targets (answer_id, role_title) values
  ('3ae4b31a-82d5-4066-adef-18b152c8e772', '一般'),
  ('3ae4b31a-82d5-4066-adef-18b152c8e772', 'フロア責任者'),
  ('3ae4b31a-82d5-4066-adef-18b152c8e772', 'リーダー'),
  ('3ae4b31a-82d5-4066-adef-18b152c8e772', 'マネージャー'),
  ('3ae4b31a-82d5-4066-adef-18b152c8e772', '社長'),
  ('3ae4b31a-82d5-4066-adef-18b152c8e772', '管理者');

-- 時間調整タブは何に使う → 一般・フロア責任者・リーダー・マネージャー・社長・管理者
delete from public.faq_answer_targets where answer_id = 'a081d319-9e77-459a-91bb-5bba726cd871';
insert into public.faq_answer_targets (answer_id, role_title) values
  ('a081d319-9e77-459a-91bb-5bba726cd871', '一般'),
  ('a081d319-9e77-459a-91bb-5bba726cd871', 'フロア責任者'),
  ('a081d319-9e77-459a-91bb-5bba726cd871', 'リーダー'),
  ('a081d319-9e77-459a-91bb-5bba726cd871', 'マネージャー'),
  ('a081d319-9e77-459a-91bb-5bba726cd871', '社長'),
  ('a081d319-9e77-459a-91bb-5bba726cd871', '管理者');

-- 有給奨励日の通知が来た → 一般・フロア責任者・リーダー・マネージャー・社長・管理者
delete from public.faq_answer_targets where answer_id = 'a8fc780e-ffca-4d26-87fa-099689781ec1';
insert into public.faq_answer_targets (answer_id, role_title) values
  ('a8fc780e-ffca-4d26-87fa-099689781ec1', '一般'),
  ('a8fc780e-ffca-4d26-87fa-099689781ec1', 'フロア責任者'),
  ('a8fc780e-ffca-4d26-87fa-099689781ec1', 'リーダー'),
  ('a8fc780e-ffca-4d26-87fa-099689781ec1', 'マネージャー'),
  ('a8fc780e-ffca-4d26-87fa-099689781ec1', '社長'),
  ('a8fc780e-ffca-4d26-87fa-099689781ec1', '管理者');

-- 購入申請の内容について質問したい → リーダー・マネージャー・社長・管理者
delete from public.faq_answer_targets where answer_id = 'ee725007-cb2c-4daf-bf7b-d0d1cdd4c915';
insert into public.faq_answer_targets (answer_id, role_title) values
  ('ee725007-cb2c-4daf-bf7b-d0d1cdd4c915', 'リーダー'),
  ('ee725007-cb2c-4daf-bf7b-d0d1cdd4c915', 'マネージャー'),
  ('ee725007-cb2c-4daf-bf7b-d0d1cdd4c915', '社長'),
  ('ee725007-cb2c-4daf-bf7b-d0d1cdd4c915', '管理者');

-- 他の人の出張報告を見たい → マネージャー・社長・管理者
delete from public.faq_answer_targets where answer_id = 'dbbbd16f-05d9-4b35-b990-3f85343c5ede';
insert into public.faq_answer_targets (answer_id, role_title) values
  ('dbbbd16f-05d9-4b35-b990-3f85343c5ede', 'マネージャー'),
  ('dbbbd16f-05d9-4b35-b990-3f85343c5ede', '社長'),
  ('dbbbd16f-05d9-4b35-b990-3f85343c5ede', '管理者');

-- 残業の申請先に自己受理があるのは誰 → マネージャー・社長・管理者
delete from public.faq_answer_targets where answer_id = 'ab3efc7c-b1af-404d-b38e-52dcaeec44d7';
insert into public.faq_answer_targets (answer_id, role_title) values
  ('ab3efc7c-b1af-404d-b38e-52dcaeec44d7', 'マネージャー'),
  ('ab3efc7c-b1af-404d-b38e-52dcaeec44d7', '社長'),
  ('ab3efc7c-b1af-404d-b38e-52dcaeec44d7', '管理者');

-- 有給申請を送信してくださいのバナー → パート・マネージャー・社長・管理者
delete from public.faq_answer_targets where answer_id = '92279c99-77cc-4c92-b5db-5c54c64b9792';
insert into public.faq_answer_targets (answer_id, role_title) values
  ('92279c99-77cc-4c92-b5db-5c54c64b9792', 'パート'),
  ('92279c99-77cc-4c92-b5db-5c54c64b9792', 'マネージャー'),
  ('92279c99-77cc-4c92-b5db-5c54c64b9792', '社長'),
  ('92279c99-77cc-4c92-b5db-5c54c64b9792', '管理者');

-- 残業や遅刻・欠勤はどこから報告する → パート・マネージャー・社長・管理者
delete from public.faq_answer_targets where answer_id = '5e2a36b4-d48f-46bf-8498-4b1d4ce3d807';
insert into public.faq_answer_targets (answer_id, role_title) values
  ('5e2a36b4-d48f-46bf-8498-4b1d4ce3d807', 'パート'),
  ('5e2a36b4-d48f-46bf-8498-4b1d4ce3d807', 'マネージャー'),
  ('5e2a36b4-d48f-46bf-8498-4b1d4ce3d807', '社長'),
  ('5e2a36b4-d48f-46bf-8498-4b1d4ce3d807', '管理者');

-- 欠勤の連絡はアプリですればいい → パート・マネージャー・社長・管理者
delete from public.faq_answer_targets where answer_id = '79d2add5-2225-4eec-9fdb-479b0ea43c17';
insert into public.faq_answer_targets (answer_id, role_title) values
  ('79d2add5-2225-4eec-9fdb-479b0ea43c17', 'パート'),
  ('79d2add5-2225-4eec-9fdb-479b0ea43c17', 'マネージャー'),
  ('79d2add5-2225-4eec-9fdb-479b0ea43c17', '社長'),
  ('79d2add5-2225-4eec-9fdb-479b0ea43c17', '管理者');

-- 勤務変更の報告を間違えて出してしまった → パート・マネージャー・社長・管理者
delete from public.faq_answer_targets where answer_id = '9cd027ce-ce91-491a-b85e-4a3892ac1976';
insert into public.faq_answer_targets (answer_id, role_title) values
  ('9cd027ce-ce91-491a-b85e-4a3892ac1976', 'パート'),
  ('9cd027ce-ce91-491a-b85e-4a3892ac1976', 'マネージャー'),
  ('9cd027ce-ce91-491a-b85e-4a3892ac1976', '社長'),
  ('9cd027ce-ce91-491a-b85e-4a3892ac1976', '管理者');

-- ② 本文の訂正
-- 時間調整タブ：反映→自動登録
update public.faq_answers set body = '「調整遅出（遅く出勤）」「調整早退（早く退勤）」を申請不要・自己登録で記録するタブです。受理フローはなく、登録するとすぐGoogleカレンダーに自動登録されます。

①種別（調整遅出／調整早退、両方可）と時刻を選ぶ
②日付（当日以降のみ）
③校
④理由

事前にフロア責任者・リーダー（マネージャー）へ必ず相談し、了承を得てから登録してください。取り消したいときはリーダー・マネージャーまたは経理担当者へご連絡ください。' where id = 'a081d319-9e77-459a-91bb-5bba726cd871';

-- 備品立替：レシートの扱いを画面と統一
update public.faq_answers set body = 'ナビの「📦 備品精算」→「💰 精算」タブから記録します。

①品目名・金額・購入日を入力
②レシートを「写真アップロード／直接提出する／レシートなし（理由を記入）」のいずれかで添付
③支払方法を「自分で立替えた（後日返金されます）」か「会社支払（会社カード・振込・代引きなど。記録のみ・返金なし）」から選んで送信

承認フローはなく、送信で記録完了です（マネージャー以上・経理に共有されます）。
立て替えた分は、その都度 現金でお返しします。
紙のレシート・領収書は原本を経理まで送ってください（7年間の保管が必要です）。' where id = '25485e1e-5f8a-46e2-9d65-5013f19c9eca';

-- 残業締め切り：依頼期限を20日に
update public.faq_answers set body = '給与期間は毎月16日〜翌月15日（15日締め・25日支給）です。

新規の申請は支給月の17日までに提出してください。それを過ぎると前の給与期間の新規申請はできなくなります（画面上でロックされます）。

締め後にどうしても申請が必要な場合は、フォームに出る「📩 経理に許可を依頼する」から対象日を選んで依頼してください。経理が許可するとその日だけ申請できるようになります。給与計算の都合上、ご依頼は遅くとも20日までにお願いいたします。やむを得ず期日を過ぎる場合は、経理までご相談ください。' where id = '44171859-bdf4-492d-b9e5-baabd3309669';

-- 調整休・欠勤（終日）：自己受理の一文を削除
update public.faq_answers set body = '時刻を入れず1日単位で記録する種別です。

①時間外調整休＝残業分の調整で休む日。受理されると、その日のシフト労働分（例：−7:00）が今期の合計時間数から差し引かれます。
②振替休日＝休日出勤の振替。振替元の勤務日・勤務校を入力します。
③欠勤＝欠勤1日として記録します（合計時間数とは別枠でカウント）。

いずれも受理された時点で完了し、実績報告は不要です。欠勤を受理できるのはマネージャー以上です。' where id = 'fa4ad670-aad5-4a8a-910d-971d283f021a';

-- 残業超過バナー：しきい値の設定の話を削除
update public.faq_answers set body = '今期（16日〜翌15日）の残業の見込み合計が、会社の設定したしきい値を超えたお知らせです。

「調整の予定を入れる」から時間外調整休などの申請を出すと、見込みが下がってバナーは自然に消えます。「後で再通知」で翌朝また表示、✕で次の配信タイミングまで非表示にできます。

調整が難しい場合はリーダー・マネージャーへご相談ください。' where id = '99d6782f-8de2-431f-84a4-c0a6a6b68958';

-- ③ 質問文の訂正（休憩ルールは勤務変更報告・残業に共通なので、どちらの人にも自分向けと分かるようにする）
update public.faq_topics set question = '休憩時間はどう決まる？（勤務変更報告・残業に共通）' where id = 'bbfd39ed-2508-48f9-830c-f3999fc4b6e0';
