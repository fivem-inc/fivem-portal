-- 社内FAQ：「経理が代わりに受理しました」と届いた（2026-10-14・経理が申請先の上長に代わって受理できるようにした）
-- 🚨 文言は画面とお知らせ（overtime-approve の on_behalf・管理画面の［代わりに受理］）から拾っている。変えるときは一緒に直す
begin;

insert into public.faq_topics (id, question, keywords, category, audience, is_published, sort_order)
values (
  'cd7d74a7-d466-415f-998f-09a3507249cf',
  '「経理が代わりに受理しました」と届いた',
  array['代わりに受理', '経理', '受理まち', '受理', '代理'],
  '残業・時間管理',
  'internal',
  true,
  430
)
on conflict (id) do nothing;

insert into public.faq_answers (id, topic_id, body, valid_from)
values (
  'edbab54e-cccb-4161-b31f-68acaaebd756',
  'cd7d74a7-d466-415f-998f-09a3507249cf',
  $faq$あなたが申請先になっていた残業申請を、経理があなたに代わって受理したお知らせです。給与の締めに間に合わせるためなどに行います。

受理はすでに済んでいるので、あなたがすることはありません。受理まちの一覧からも消えています。

申請した本人には、いつもと同じ「受理されました」のお知らせが届いています。内容に気になる点があるときは、経理にご相談ください。$faq$,
  '2026-10-14'
)
on conflict (id) do nothing;

commit;
