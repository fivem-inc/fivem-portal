-- 社内FAQ：打刻ズレの記録を自分で取り消せないとき（2026-10-15 ユーザー確定 A）
-- ・経理が「確認済み」にした打刻ズレは、本人の［取消］が出ない（enforce の作り）
-- ・打刻の確認への答え「業務はしていません」でできた打刻ズレは、できた時点で確認済み（20261014224255）
-- 🚨 文は画面（OvertimeClockInquiryPanel の説明）とそろえている。変えるときは一緒に直す

begin;

insert into public.faq_topics (id, question, keywords, category, audience, is_published, sort_order)
values (
  '55831d7c-8e26-4dd4-a7a0-d88631d56545',
  '打刻ズレの記録が取り消せない',
  array['打刻ズレ', '打刻', '取消', '取り消し', '確認済み', '経理', '打刻の確認'],
  '残業・時間管理',
  'internal',
  true,
  365
)
on conflict (id) do nothing;

insert into public.faq_answers (id, topic_id, body, valid_from)
values (
  '68fbf074-bffd-43b4-9b64-08cf81f7dcb6',
  '55831d7c-8e26-4dd4-a7a0-d88631d56545',
  $faq$経理が打刻と突き合わせて「確認済み」にした記録は、ご自身では取り消せません。経理が確認した日を正しく残すためです。

打刻の確認に答えてできた記録は、答えた時点で確認済みになります。

内容を直したいときは、経理までご相談ください。$faq$,
  '2026-10-15'
)
on conflict (id) do nothing;

commit;
