-- ============================================================
-- 2026-11-07  社内FAQ：前回の入力が残っていて、送ろうとするとエラーになる（全員）
-- ============================================================
-- ・きっかけ：前回の入力の続きが黙って戻り、「実際の時刻を入力してください」で止まったが、
--   何がだめなのか分からずFAQを探した（マネージャーの方の報告・2026-11-07 ユーザー確定）
-- ・画面 client/src/components/DraftRestoredLine.tsx（黄色の1行 DRAFT_RESTORED_TEXT・エラーに足す文 DRAFT_HINT_TEXT）
-- ・見せる相手は全員（faq_answer_targets を入れない）
-- 🚨 黄色の1行・［クリア］の名前を変えたらこの文も直す
-- 🚨 IDは固定。何度流しても増えない。valid_from を必ず入れる（空だと下書き扱いで誰にも出ない）

begin;

insert into faq_topics (id, audience, category, question, keywords, is_published, is_featured, needs_review, sort_order)
values
  ('0e10fa70-62d9-484e-b001-bd66c3c290b6', 'internal', 'アカウント・通知',
   '前の入力が残っていて、送ろうとするとエラーになる',
   array['前回の入力', '前の入力', '入力の続き', '下書き', 'クリア', 'エラー', '送れない', '時刻を入力してください', '時間を入力してください', '残っている'], true, false, false, 900)
on conflict (id) do update
  set category = excluded.category,
      question = excluded.question,
      keywords = excluded.keywords,
      is_published = excluded.is_published,
      sort_order = excluded.sort_order;

insert into faq_answers (id, topic_id, valid_from, body)
values
  ('79ac9837-078d-4d7d-8f0c-34151a867c70', '0e10fa70-62d9-484e-b001-bd66c3c290b6', '2026-11-07',
   $faq$入力の途中の内容は、その端末に自動で残ります。次にページを開いたとき、上に黄色で「📋 前回の入力の続きを表示しています。」と出ていれば、前回の続きです。新しく入力するときや、送ろうとしてエラーになるときは、右上の［クリア］を押してから入力し直してください。$faq$)
on conflict (id) do update set body = excluded.body, valid_from = coalesce(faq_answers.valid_from, excluded.valid_from);

commit;
