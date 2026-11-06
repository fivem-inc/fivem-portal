-- ============================================================
-- 2026-11-06  社内FAQ：勤務変更の事前申請（先の日の残業・早退・休日出勤など）
-- ============================================================
-- ・画面 client/src/pages/ShiftReportPage.tsx（ページの説明の②・AdvanceBand・AdvanceReportBox）／DB 20261106000727・20261106142056
-- ・見せる相手は権限 shift_report_advance に合わせて 社長・管理者だけ。
--   🚨 パートの方へ権限を広げるときは、この答えの faq_answer_targets も同時に広げる
-- 🚨 ボタンの名前・流れを変えたらこの文も直す
-- 🚨 IDは固定。何度流しても増えない。valid_from を必ず入れる（空だと下書き扱いで誰にも出ない）

begin;

insert into faq_topics (id, audience, category, question, keywords, is_published, is_featured, needs_review, sort_order)
values
  ('b6d9da16-d4cc-421c-af95-8420bc71b6c7', 'internal', '勤務変更報告',
   '勤務変更の事前申請とは？（先の日の残業・早退・休日出勤など）',
   array['事前申請', '勤務変更', '先の日', '前もって', '残業', '早退', '休日出勤', '申請どおり', '時間が違いました', '変更はありませんでした'], true, false, false, 240)
on conflict (id) do update
  set category = excluded.category,
      question = excluded.question,
      keywords = excluded.keywords,
      is_published = excluded.is_published,
      sort_order = excluded.sort_order;

insert into faq_answers (id, topic_id, valid_from, body)
values
  ('62550075-73c5-46ff-8ec7-de90a5c17540', 'b6d9da16-d4cc-421c-af95-8420bc71b6c7', '2026-11-06',
   $faq$先の日を選ぶと「事前申請」として送られ、上長が受理します。

【その日の勤務のあと】
履歴のカードの「申請どおりでしたか？」から、次の3つのどれかを押してください。
・［申請どおりでした（確定）］…受理なしで確定します（申請した勤務が終わってから押せます）
・［時間が違いました］…実際の時間に直して送ると、上長の確認になります
・［申請した変更はありませんでした（いつもどおり勤務）］…申請は取り消されます

【その日より前】
受理のあとに内容を変えると、受理はやり直しになります。取り消すこともできます。

※欠勤・打刻忘れは事前申請にしません。今までどおり報告してください。
※上長が勤怠カレンダーに入れた日は、事前申請できません。$faq$)
on conflict (id) do update set body = excluded.body, valid_from = coalesce(faq_answers.valid_from, excluded.valid_from);

delete from faq_answer_targets where answer_id = '62550075-73c5-46ff-8ec7-de90a5c17540'::uuid;
insert into faq_answer_targets (answer_id, role_title) values
  ('62550075-73c5-46ff-8ec7-de90a5c17540'::uuid, '社長'),
  ('62550075-73c5-46ff-8ec7-de90a5c17540'::uuid, '管理者');

commit;
