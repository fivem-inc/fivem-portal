-- 社内FAQ：申請の依頼はどこから作る？（2026-10-15）
-- きっかけ：入口が休暇の受理ページの中だけで、残業の依頼を作りたい上長が迷った（10/15 実機）。
--   同じ日に、残業の確認ページにも［依頼を作る］を置いた（components/AppRequestBox）。
-- 🚨 文は画面（AppRequestBox・ApplicationRequestSheet の説明）とそろえている。変えるときは一緒に直す

begin;

insert into public.faq_topics (id, question, keywords, category, audience, is_published, sort_order)
values (
  '9441b38f-be34-4ae8-9b4c-cd1d8724d9a7',
  '申請の依頼はどこから作る？（上長）',
  array['申請の依頼', '申請依頼', '依頼を作る', '依頼', '調整休', '振替休日', '上長', '確認ページ', '受理ページ'],
  '残業・時間管理',
  'internal',
  true,
  419
)
on conflict (id) do nothing;

insert into public.faq_answers (id, topic_id, body, valid_from)
values (
  '104372ca-eab2-4e94-8f63-3b26a6f452b9',
  '9441b38f-be34-4ae8-9b4c-cd1d8724d9a7',
  $faq$次のどちらからでも作れます（中身は同じです）。
・「残業・時間」→「✅ 確認ページへ」→「📩 正社員へ 申請を依頼」→「依頼を作る」
・「休暇申請」→「✅ 受理ページへ」→「📩 正社員へ 申請を依頼」→「依頼を作る」

①依頼の種類を選ぶ（時間外調整休・振替休日は「残業・時間管理」です。「休暇」を選ぶと、相手は申請できません）
②残業の依頼は「申請内容」を選ぶ（時間／時間外調整休／振替休日／欠勤／本人が選択）。選んだ内容は、相手の申請画面にあらかじめ入力されます
③相手・日付・メモを入れて送る

出した依頼は、同じ場所の一覧で状態（未申請・申請済み など）を確かめたり、取り下げたりできます。
ボタンが見当たらない場合は、まだ使える役職になっていません。$faq$,
  '2026-10-15'
)
on conflict (id) do nothing;

commit;
