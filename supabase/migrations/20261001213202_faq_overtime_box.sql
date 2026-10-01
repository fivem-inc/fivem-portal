-- ============================================================
-- 2026-10-01  社内FAQ：残業の［まとめて申請］を足す（ユーザー確定「案A」）
-- ============================================================
-- 🚨 機能を変えたら社内FAQも同時に直す。［まとめて申請］（2026-09-29〜30）の説明がまだ無かった。
-- ・形は「表入力とは？」（921）と同じ「〇〇とは？」＋手順。2026-10-01 の「時刻の打ち間違いはその場で赤く出る」も書く
-- ・対象は［まとめて申請］を使える役職（feature_permissions の overtime_grid が on＝リーダー・マネージャー・社長・管理者・2026-10-01 実測）
--   🚨 一般の方には出さない（使えない機能へ案内してしまう。921 と同じ考え方）
-- ・検索語「まとめて」は、表入力（921）からこちらへ移す（「まとめて」で探した人の多くはスマホの［まとめて申請］のため）
-- 🚨 IDは固定。何度流しても増えない（質問・回答は on conflict update、対象役職は delete→insert）。
-- 🚨 faq_answer_targets は（回答×役職）に一意制約が無い。入れる前に消す。role_id はトリガーが役職名から入れる。

insert into faq_topics (id, audience, category, question, keywords, is_published, is_featured, needs_review, sort_order)
values
  ('b0000000-0000-4000-8000-000000000926', 'internal', '残業・時間管理',
   '残業の「まとめて申請」とは？',
   array['まとめて申請', 'まとめて', '複数日', '何日分', 'スマホ', 'リスト', '複製'], true, false, false, 303)
on conflict (id) do update
  set category = excluded.category,
      question = excluded.question,
      keywords = excluded.keywords,
      is_published = excluded.is_published,
      sort_order = excluded.sort_order;

-- 🚨 valid_from（いつから見せるか）を必ず入れる。空だと「下書き」扱いで誰の画面にも出ない（lib/faq.ts の isAnswerActiveOn）。
--    2026-10-01 に、9/9〜9/26 に migration で足した10件もこれが空で、一度も表示されていなかったと分かった
insert into faq_answers (id, topic_id, valid_from, body)
values
  ('b0000000-0000-4000-8000-000000000936', 'b0000000-0000-4000-8000-000000000926', '2026-10-01',
   E'何日分かの残業の事前申請・事後報告を、1日分ずつリストに入れて、まとめて送れます。スマートフォンでも使えます。\n'
   || E'\n'
   || E'①残業ページの「まとめて申請」タブを開く\n'
   || E'②日付・時間・勤務地・理由・申請先を入れて「＋ 申請リストに追加」\n'
   || E'③2件目からは「複製」を押し、日付と時間だけ変えると早いです\n'
   || E'④「申請する（◯件）」→ 確認画面で送信\n'
   || E'\n'
   || E'一度に入れられるのは10件までです。「申請する」を押すまでは送信されません。入れた内容はその端末にだけ保存されます。\n'
   || E'時刻の打ち間違い（夕方5時を 5:00 と入れた など）は、その場で赤く表示されます。\n'
   || E'実績報告・差し戻しの再提出・内容の修正は「履歴・実績報告」タブから1件ずつ行ってください。\n'
   || E'タブが見当たらない場合は、まだ使える役職になっていません。')
on conflict (id) do update set body = excluded.body, valid_from = coalesce(faq_answers.valid_from, excluded.valid_from);

delete from faq_answer_targets where answer_id = 'b0000000-0000-4000-8000-000000000936'::uuid;

insert into faq_answer_targets (answer_id, role_title)
select 'b0000000-0000-4000-8000-000000000936'::uuid, r.role_title
  from (values ('リーダー'), ('マネージャー'), ('社長'), ('管理者')) as r(role_title);

-- 表入力（921）の検索語から「まとめて」だけ外す（「一括」は残す）
update faq_topics
   set keywords = array_remove(keywords, 'まとめて')
 where id = 'b0000000-0000-4000-8000-000000000921';
