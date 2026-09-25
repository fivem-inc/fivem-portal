-- ============================================================
-- 2026-09-25  社内FAQ：残業申請「表入力」を足す
-- ============================================================
-- 🚨 機能を変えたら社内FAQも同時に直す。表入力をリーダーにも広げたため（権限管理・2026-09-25）。
-- ✅ ユーザー確定：
--   ・画面のボタン名は「📋 残業申請「表入力」（パソコン専用）」（試験中は付けない）
--   ・質問は「残業申請の「表入力」とは？（パソコン専用）」。答えの1行目で何ができるかを書く
-- ・対象はリーダー・マネージャー・社長・管理者（いま表入力を使える役職）。
--   🚨 既存の「残業はどこから申請する？」には足さない。一般の方にも見える答えなので、使えない機能へ案内してしまう
-- 🚨 IDは固定。何度流しても増えない（質問・回答は on conflict update、対象役職は delete→insert）。
-- 🚨 faq_answer_targets は（回答×役職）に一意制約が無い。入れる前に消す（2026-09-09 に二重になった）。
--    role_id はトリガー（role_rules_sync_role_id）が役職名から入れる。

insert into faq_topics (id, audience, category, question, keywords, is_published, is_featured, needs_review, sort_order)
values
  ('b0000000-0000-4000-8000-000000000921', 'internal', '残業・時間管理',
   '残業申請の「表入力」とは？（パソコン専用）',
   array['表入力', '表', 'スプレッドシート', '一覧', 'まとめて', '一括', 'パソコン'], true, false, false, 305)
on conflict (id) do update
  set category = excluded.category,
      question = excluded.question,
      keywords = excluded.keywords,
      is_published = excluded.is_published,
      sort_order = excluded.sort_order;

insert into faq_answers (id, topic_id, body)
values
  ('b0000000-0000-4000-8000-000000000931', 'b0000000-0000-4000-8000-000000000921',
   E'何日分もの残業の申請・報告を、スプレッドシートのような表で入力し、まとめて送れます。パソコンで開いたときだけ使えます。\n'
   || E'\n'
   || E'①残業ページの「事前申請・事後報告」か「履歴・実績報告」タブで「📋 残業申請「表入力」（パソコン専用）」を押す\n'
   || E'②1行＝1日です。時間を入れた日だけ送ります（空の日と、通常シフトと同じ日は送りません）\n'
   || E'③事前申請・事後報告・実績報告・再提出は、その日の状態に合わせて自動で切り替わります\n'
   || E'④実績報告は「予定どおり」「残業なし」のボタンでも入力できます\n'
   || E'⑤申請先は表の上で選びます（行ごとに変えることもできます）。申請の依頼が届いている日は、依頼した人が申請先になります\n'
   || E'⑥「◯件を確認して送信」→ 確認画面で「送信する」\n'
   || E'\n'
   || E'1日ずつ、いつもの申請として登録されます（受理・差し戻しもいつもどおりです）。\n'
   || E'入力途中の内容は、その端末に保存されます。スマートフォン・タブレットには表示されません。\n'
   || E'ボタンが見当たらない場合は、まだ使える役職になっていません。')
on conflict (id) do update set body = excluded.body;

delete from faq_answer_targets where answer_id = 'b0000000-0000-4000-8000-000000000931'::uuid;

insert into faq_answer_targets (answer_id, role_title)
select 'b0000000-0000-4000-8000-000000000931'::uuid, r.role_title
  from (values ('リーダー'), ('マネージャー'), ('社長'), ('管理者')) as r(role_title);
