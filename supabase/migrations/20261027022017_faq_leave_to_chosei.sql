-- ============================================================
-- 2026-10-27  社内FAQ：有休を時間外調整休に変える（段2a）
-- ============================================================
-- ・計画 docs/計画-言葉をそろえる-休暇の種類の変更.md。DB 20261027001922_leave_to_chosei_replace.sql・画面 lib/leaveReplace.ts／components/LeaveKindGuideCard.tsx
-- 🚨 ご本人に届く「休暇の種類のご案内」の文言（ユーザー確定）と食い違わないようにする。決まりを変えたらこの文も直す
-- 🚨 IDは固定。何度流しても増えない。valid_from を必ず入れる（空だと下書き扱いで誰にも出ない）

begin;

insert into faq_topics (id, audience, category, question, keywords, is_published, is_featured, needs_review, sort_order)
values
  ('058d0837-4cf8-4bbd-8aa9-461b41dba62c', 'internal', '休暇申請',
   '有休を時間外調整休に変えたい',
   array['有休', '有給休暇', '時間外調整休', '調整休', '変更', '切り替え', '休暇の種類', 'ご案内', 'バースデー休暇'], true, false, false, 344)
on conflict (id) do update
  set category = excluded.category,
      question = excluded.question,
      keywords = excluded.keywords,
      is_published = excluded.is_published,
      sort_order = excluded.sort_order;

insert into faq_answers (id, topic_id, valid_from, body)
values
  ('aa2273d3-06ee-45b5-9405-393c41f0aeab', '058d0837-4cf8-4bbd-8aa9-461b41dba62c', '2026-10-27',
   $faq$有給休暇・バースデー休暇は、1日ずつ時間外調整休に変えられます（残業申請を使える方）。

【ご自分で変えるとき】
・休暇申請の［申請履歴］で、その休暇のカードの［時間外調整休に変える］を押します
・残業申請の画面（その日・時間外調整休）が開きます。申請先はマネージャー以上の方です
・何日かまとめて取った休暇は、変える日を選びます

【上長から「休暇の種類のご案内」が届いたとき】
・残業ページの［履歴・実績報告］に、その日の残業時間と、時間外調整休に変更した場合の時間が出ます
・変更される場合は［時間外調整休を申請する］、変更されない場合は［有給休暇のままとする］を押してください
・押さなくても有給休暇のままです。有給休暇のままでも、不利益な取扱いはございません

【受理されると】
・その日の有給休暇は取り消されます（何日かまとめて取った休暇は、その日だけ）。受理されるまでは有給休暇のままです
・時間外調整休は、その日のシフト労働分が、今期の合計時間数から差し引かれます

【変えられないもの】
・有休奨励日の休み
・給与計算が始まった期間（支給月の17日以降）の日。管理者に修正を依頼してください

【上長の方へ】
・［申請の依頼］で「残業・時間管理」「時間外調整休」と日付を選ぶと、ご本人の有休がある日は「この有休を、時間外調整休に変更できることをご本人に案内する」が出ます（権限「休暇の種類のご案内」の方だけ）
・選ぶのはご本人です。同じ日の案内は1回限りです$faq$)
on conflict (id) do update set body = excluded.body, valid_from = coalesce(faq_answers.valid_from, excluded.valid_from);

commit;
