-- ============================================================
-- 2026-10-29  社内FAQ：連絡板のアンケート（全員）
-- ============================================================
-- ・計画 docs/計画-連絡板のアンケート.md。DB 20261029150633_board_survey.sql・画面 components/board/Survey*.tsx・lib/boardSurvey.ts
-- 🚨 作れる人（権限 board_survey）・見せ方・直せる期間を変えたらこの文も直す
-- 🚨 IDは固定。何度流しても増えない。valid_from を必ず入れる（空だと下書き扱いで誰にも出ない）

begin;

insert into faq_topics (id, audience, category, question, keywords, is_published, is_featured, needs_review, sort_order)
values
  ('e5bc4fb8-feea-4e2e-9a21-f287993a2390', 'internal', '連絡板',
   '連絡板のアンケートに回答するには？（作るには？）',
   array['アンケート', '回答', '質問', '希望確認', 'Googleフォーム', 'フォーム', '回答を直す', '期限後', 'お知らせ'], true, false, false, 821)
on conflict (id) do update
  set category = excluded.category,
      question = excluded.question,
      keywords = excluded.keywords,
      is_published = excluded.is_published,
      sort_order = excluded.sort_order;

insert into faq_answers (id, topic_id, valid_from, body)
values
  ('b6c3170d-4313-47e5-8fd5-229878559f19', 'e5bc4fb8-feea-4e2e-9a21-f287993a2390', '2026-10-29',
   $faq$連絡板の受信トレイで「📋 アンケート（◯問）」と出ているお知らせを開くと、質問が並んでいます。選ぶ・書く・日付を選ぶで答えて［回答を送る］を押してください。

【回答のしかた】
・「必須」と書かれた質問は、答えないと送れません（送ろうとすると、その質問に赤い枠が出ます）
・上の「◯/◯問」で、いくつ答えたかが分かります
・途中で閉じても、書きかけはこの端末に残ります

【回答を直す】
・期限の日までは［回答を直す］で直せます
・期限を過ぎても回答はできますが、送ったあとは直せません（送る前にそのことが出ます）

【ほかの人の回答】
・ふだんは、送った人と写し（CC）の代表者だけが見られます
・アンケートによっては、回答したあとに［みんなの回答を見る］が出ます（選択肢ごとの数だけ、または名前つき。名前つきのときは送る前にそのことが出ます）

【作るには】
・お知らせの作成で、種別「✏️ 回答」を選び［質問に答えてもらう］を押します（今のところマネージャー・社長・管理者だけ）
・答え方は「1つ選ぶ」「いくつでも選ぶ」「文字で書く」「日付を選ぶ」の4つ。質問は↑↓で並べ替えられます
・回答は送信トレイのお知らせを開くと見られます（未回答の人・Excel で出す）。まだ回答が無いうちは質問を直せます$faq$)
on conflict (id) do update set body = excluded.body, valid_from = coalesce(faq_answers.valid_from, excluded.valid_from);

commit;
