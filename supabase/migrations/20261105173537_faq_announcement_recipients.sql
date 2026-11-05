-- ============================================================
-- 2026-11-05  社内FAQ：管理者からのお知らせの出し方と宛先（マネージャー・社長・管理者）
-- ============================================================
-- ・DB 20261105170548_announcement_recipients.sql・画面 components/admin/AnnouncementsTab.tsx・AnnouncementRecipientPicker.tsx
-- 🚨 宛先のボタン・注意の文を変えたらこの文も直す
-- 🚨 IDは固定。何度流しても増えない。valid_from を必ず入れる（空だと下書き扱いで誰にも出ない）

begin;

insert into faq_topics (id, audience, category, question, keywords, is_published, is_featured, needs_review, sort_order)
values
  ('b1dc4668-2b31-4562-88b7-819c8b810817', 'internal', 'アカウント・通知',
   '管理者からのお知らせ（ホームに出るお知らせ）を出す・宛先を選ぶには？',
   array['お知らせ', '管理者からのお知らせ', '宛先', '正社員だけ', 'パートだけ', 'ホームのお知らせ', 'バナー', '届く人'], true, false, false, 830)
on conflict (id) do update
  set category = excluded.category,
      question = excluded.question,
      keywords = excluded.keywords,
      is_published = excluded.is_published,
      sort_order = excluded.sort_order;

insert into faq_answers (id, topic_id, valid_from, body)
values
  ('e6d67672-ea07-421f-8ff2-b1060fda1a6f', 'b1dc4668-2b31-4562-88b7-819c8b810817', '2026-11-05',
   $faq$管理画面の「📢 お知らせ」から出します。

【出し方】
・タイトルと本文を書き、「宛先」を選んで［お知らせを出す］を押します
・宛先のボタンは連絡板と同じです（全員・正社員・パート・マネージャー・リーダー・こども・大人・管理部）。いくつでも選べて、「個別に追加」で名前から1人ずつ足すこともできます
・「届く人◯人」で人数が分かります。［届く人を見る ▼］で名前を確かめられます
・最初は「全員」が選ばれています。正社員だけに出すときは、［全員］を押して外してから［正社員］を押してください

【届く人だけに出るもの】
ホームのお知らせ・過去のお知らせ・🔔ベル・メール・スマホの通知（作成時・リマインド）は、宛先の方にだけ出ます

【あとから入った方・宛先を直すとき】
・宛先は、出した時点の方で決まります（あとから入社した方や、役職が変わった方には出ません）
・出したあとでも［編集］で宛先を直せます。足した方には、作成時の通知の設定どおりに通知が届きます
・外した方の画面（ホーム・過去のお知らせ・ベル）からは消えます。ただし、すでに届いたメール・スマホの通知は取り消せません（外す前に注意が出ます）$faq$)
on conflict (id) do update set body = excluded.body, valid_from = coalesce(faq_answers.valid_from, excluded.valid_from);

delete from faq_answer_targets where answer_id = 'e6d67672-ea07-421f-8ff2-b1060fda1a6f'::uuid;
insert into faq_answer_targets (answer_id, role_title) values
  ('e6d67672-ea07-421f-8ff2-b1060fda1a6f'::uuid, 'マネージャー'),
  ('e6d67672-ea07-421f-8ff2-b1060fda1a6f'::uuid, '社長'),
  ('e6d67672-ea07-421f-8ff2-b1060fda1a6f'::uuid, '管理者');

commit;
