-- 文字の大きさ（2026-10-15 ユーザー確定）：社内FAQ 1件＋ホームのお知らせ（2週間・✕で各自が閉じる）
-- 🚨 FAQ の文は画面（components/TextScaleChoice.tsx・lib/textScale.ts）から拾っている。変えるときは一緒に直す
-- 🚨 お知らせは SQL で入れるので、作成時のスマホ通知・メール（announcement-notify）は飛ばない。
--    念のため notify_on_create_* を false・notified_at を入れて、あとから送られることもないようにする

begin;

insert into public.faq_topics (id, question, keywords, category, audience, is_published, sort_order)
values (
  '9142c2e5-7a78-4d15-91b6-65f9ef1eaab1',
  'スマホの文字を大きくしたい',
  array['文字', '大きく', '大きさ', '小さい', '見えにくい', '老眼', 'サイズ', '拡大', 'スマホ'],
  'アカウント・通知',
  'internal',
  true,
  1070
)
on conflict (id) do nothing;

insert into public.faq_answers (id, topic_id, body, valid_from)
values (
  '8d054597-ede0-453f-97fc-5509951887b3',
  '9142c2e5-7a78-4d15-91b6-65f9ef1eaab1',
  $faq$右上の丸いアイコン（名前の頭文字）を押し、「文字の大きさ」で［大きめ］か［特大］を選んでください。そのスマホだけに効きます。元に戻すときは［標準］を押してください。

パソコンでは、キーボードの［Ctrl］と［＋］で大きくできます（元に戻すのは［Ctrl］と［0］）。$faq$,
  '2026-10-15'
)
on conflict (id) do nothing;

insert into public.announcements
  (id, title, body, active, starts_at, ends_at,
   notify_on_create_push, notify_on_create_email, remind_in_app, remind_push, remind_email,
   remind_days_before, remind_frequency, push_show_title, notified_at)
values (
  '2296c1cf-589b-4f3f-be06-444dcc59d24b',
  'スマホの文字を大きくできるようになりました',
  $ann$右上の丸いアイコン（名前の頭文字）を押し、「文字の大きさ」で［大きめ］か［特大］を選んでください。
そのスマホだけに効きます。元に戻すときは［標準］を押してください。$ann$,
  true,
  '2026-10-15 00:00:00+09',
  '2026-10-29 23:59:59+09',
  false, false, false, false, false,
  1, 'once', false, now()
)
on conflict (id) do nothing;

commit;
