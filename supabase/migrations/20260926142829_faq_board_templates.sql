-- ============================================================
-- 2026-09-26  社内FAQ：お知らせの「テンプレート」を足す（(142)）
-- ============================================================
-- 🚨 機能を変えたら社内FAQも同時に直す。連絡板のお知らせにテンプレート（個人／全体）を足したため。
-- ✅ ユーザー確認済みの文面（2026-09-26）。
-- ・対象＝全員（faq_answer_targets を入れない＝全員に見える。既存の20件と同じ形）。
--   個人テンプレは誰でも使えるため。全体に登録できる役職は権限管理で変わるので、文面に役職名は書かない
-- ・連絡板の分類の 805（「受信トレイ・グループ・DM の違い」800 の次）
-- 🚨 IDは固定。何度流しても増えない（on conflict update）。
-- 🚨 番号は本番で使われていないことを select で確かめてから決める（922/932 はシフト調整の FAQ で使用済みだった・2026-09-26）。

insert into faq_topics (id, audience, category, question, keywords, is_published, is_featured, needs_review, sort_order)
values
  ('b0000000-0000-4000-8000-000000000925', 'internal', '連絡板',
   'お知らせの「テンプレート」とは？',
   array['テンプレート', 'テンプレ', '定型文', 'お知らせ', '件名', '本文', '全体', '自分だけ', '分類'], true, false, false, 805)
on conflict (id) do update
  set category = excluded.category,
      question = excluded.question,
      keywords = excluded.keywords,
      is_published = excluded.is_published,
      sort_order = excluded.sort_order;

insert into faq_answers (id, topic_id, body)
values
  ('b0000000-0000-4000-8000-000000000935', 'b0000000-0000-4000-8000-000000000925',
   E'よく送るお知らせの「件名と本文」を型として登録しておき、次から呼び出せる機能です。宛先・期限は入りません（その都度選びます）。\n'
   || E'\n'
   || E'①「＋お知らせ送信」→ 送信ボタンの左の「📋 テンプレートから」→ 一覧から選んで「使う」\n'
   || E'②書いた件名・本文を残すときは、送信ボタンの左の「保存」（受信・送信トレイで開いたお知らせの「📋 テンプレートに保存」からもできます）\n'
   || E'③「自分だけ」に保存すると本人にしか見えません。「全体」に保存するとお知らせを送れる人全員が使えます（全体に登録・修正できる役職は、管理画面の権限管理で決めています）\n'
   || E'④分類（連絡・お願い・依頼など）と検索で探せます。分類の一覧は管理者が管理画面で変えられます')
on conflict (id) do update set body = excluded.body;

-- 確認用:
--   select t.question, t.sort_order, (select count(*) from faq_answer_targets x where x.answer_id = a.id) as targets
--     from faq_topics t join faq_answers a on a.topic_id = t.id where t.id = 'b0000000-0000-4000-8000-000000000925';
