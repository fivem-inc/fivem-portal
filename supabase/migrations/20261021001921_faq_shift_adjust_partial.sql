-- ============================================================
-- 2026-10-21  社内FAQ：遅出・早退・勤務地変更でもシフト調整（2026-10-20 ユーザー確定の文・docs/計画-遅出早退勤務地変更のシフト調整.md）
-- ============================================================
-- ① 新規「遅出・早退・勤務地変更のときのシフト調整は？」（勤怠カレンダー・「シフト調整」タブの FAQ（740）のすぐ後ろ）
-- ② 「『シフト調整』タブで何ができる？」の1行目に、遅出・早退・勤務地変更を足す
-- ③ 「『シフト調整がまだの休みが◯件』の通知が来た」の題を、毎朝のまとめの新しい文に合わせる（「シフト調整が済んでいない相談が◯件」）
-- ・見せる相手は roles.is_leader_plus の役職（2026-10-21 実測＝リーダー・マネージャー・社長・管理者＝シフト調整の権限 leave_shift_adjust が付いている役職と同じ）。
--   ②③ は今までマネージャー・社長・管理者だけ → リーダーを足す（毎朝のまとめはリーダーにも届くのに、その FAQ をリーダーが見られなかった）
--   🚨 役職名を直書きしない
-- 🚨 IDは固定。何度流しても増えない（①は on conflict update・対象役職は delete→insert／②③の対象役職は無いものだけ足す）
-- 🚨 valid_from を必ず入れる（空だと下書き扱いで誰にも出ない）

begin;

-- ① 新規
insert into faq_topics (id, audience, category, question, keywords, is_published, is_featured, needs_review, sort_order)
values
  ('9c7126cc-ef7a-46bb-a6be-cbecaeec2bb1', 'internal', '勤怠カレンダー',
   '遅出・早退・勤務地変更のときのシフト調整は？',
   array['シフト調整', '遅出', '早退', '遅刻', '調整遅出', '調整早退', '勤務地変更', '代わり', '必要', '調整不要', '受理'], true, false, false, 745)
on conflict (id) do update
  set category = excluded.category,
      question = excluded.question,
      keywords = excluded.keywords,
      is_published = excluded.is_published,
      sort_order = excluded.sort_order;

insert into faq_answers (id, topic_id, valid_from, body)
values
  ('cc9ba40f-c007-4830-b2d9-425352d92858', '9c7126cc-ef7a-46bb-a6be-cbecaeec2bb1', '2026-10-21',
   $faq$遅刻・調整遅出・早退・調整早退・勤務地変更の事前申請を受理するとき、「シフト調整（いつもの校 時間 いない時間）」を［必要］［調整不要］から選べます（最初は「調整不要」）。
「必要」で受理すると、シフト調整のタブに相談ができ、マネージャーが代わりを決めます。判断がつかない場合は「必要」を選択してください。
受理したあとでも、残業の部門集計の人の詳細から「必要に変える」「調整不要に変える」ができます（いない時間が始まる前まで）。
選べるのはシフト調整の権限がある方です。事後報告・出張報告からの申請では選べません。$faq$)
on conflict (id) do update set body = excluded.body, valid_from = coalesce(faq_answers.valid_from, excluded.valid_from);

delete from faq_answer_targets where answer_id = 'cc9ba40f-c007-4830-b2d9-425352d92858'::uuid;

insert into faq_answer_targets (answer_id, role_title)
select 'cc9ba40f-c007-4830-b2d9-425352d92858'::uuid, r.name
  from roles r
 where r.is_leader_plus;

-- ② 「シフト調整」タブの FAQ の1行目
update faq_answers
   set body = replace(body,
         '受理された休暇・欠勤の日ごとに、抜けたシフトをどうするかを決めて記録する画面です。',
         '受理された休暇・欠勤（と、シフト調整を「必要」にした遅出・早退・勤務地変更）の日ごとに、抜けたシフトをどうするかを決めて記録する画面です。'),
       updated_at = now()
 where id = 'b0000000-0000-4000-8000-000000000932'
   and body like '受理された休暇・欠勤の日ごとに、抜けたシフトをどうするかを決めて記録する画面です。%';

-- ③ 毎朝のまとめの FAQ の題
update faq_topics
   set question = '「シフト調整が済んでいない相談が◯件」の通知が来た'
 where id = 'b0000000-0000-4000-8000-000000000905'
   and question = '「シフト調整がまだの休みが◯件」の通知が来た';

-- ②③ にリーダー以上で足りない役職を足す（今ある対象はそのまま）
insert into faq_answer_targets (answer_id, role_title)
select a.id, r.name
  from (values ('b0000000-0000-4000-8000-000000000932'::uuid), ('b0000000-0000-4000-8000-000000000915'::uuid)) as a(id)
 cross join roles r
 where r.is_leader_plus
   and not exists (select 1 from faq_answer_targets t where t.answer_id = a.id and t.role_title = r.name);

commit;
