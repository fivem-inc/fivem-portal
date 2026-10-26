-- ============================================================
-- 2026-10-26  社内FAQ：連絡板の「送信の取り消し」（全員）
-- ============================================================
-- ・計画 docs/計画-連絡板の送信の取り消し.md。DB 20261026193037_board_send_undo.sql・画面 lib/boardSendUndo.ts／components/BoardUndoBand.tsx
-- 🚨 取り消せる時間（10秒）・取り消せないもの（急ぎ・安否確認）を変えたらこの文も直す
-- 🚨 IDは固定。何度流しても増えない。valid_from を必ず入れる（空だと下書き扱いで誰にも出ない）

begin;

insert into faq_topics (id, audience, category, question, keywords, is_published, is_featured, needs_review, sort_order)
values
  ('694b862b-37ff-4c5e-bc1b-96c587a75bc4', 'internal', '連絡板',
   '連絡板で送ったあと、取り消せる？',
   array['送信の取り消し', '取り消す', '送信取消', 'まちがえて送った', '誤送信', '送信待ち', 'お知らせ', 'グループ', 'DM'], true, false, false, 343)
on conflict (id) do update
  set category = excluded.category,
      question = excluded.question,
      keywords = excluded.keywords,
      is_published = excluded.is_published,
      sort_order = excluded.sort_order;

insert into faq_answers (id, topic_id, valid_from, body)
values
  ('6485529a-2afd-46cb-9511-2279a074f0bc', '694b862b-37ff-4c5e-bc1b-96c587a75bc4', '2026-10-26',
   $faq$［送信］のあと、画面の下に「送信しました［取り消す］」が少しの間（約10秒）出ます。その間に［取り消す］を押すと、送らずに止まり、書いた内容（宛先・件名・本文・種別など）が作成の画面に戻ります。

【取り消せるもの】
・お知らせ・グループ・DM・スレッドへの返信・お知らせへの返信・DM の一斉送信
・帯が出ている間は、相手にはまだ何も届いていません（ベル・スマホの通知・メールも出ません）

【取り消せないもの】
・「⚡当日の連絡・緊急」と安否確認は、待たずにすぐ送ります（取り消しはできません）
・帯が消えたあとは送信済みです。送信トレイから削除はできますが、すでに届いたスマホの通知とメールは取り消せません

【そのほか】
・［取り消す］を押さなければ、ほかの画面に移っても、アプリを閉じても送られます（閉じたときは1分ほど遅れることがあります）
・通信がつながらないときは取り消せません（そのまま送られます）
・自分で日時を決めた送信予約は、送信トレイの「📅 予約済み」で開いて削除すれば、送られません$faq$)
on conflict (id) do update set body = excluded.body, valid_from = coalesce(faq_answers.valid_from, excluded.valid_from);

commit;
