-- 「アカウント設定」を「設定」に名前を変え、文字の大きさをその中に移した（2026-10-15 ユーザー指示）
-- ・社内FAQ 2件の「アカウント設定」→「設定」（言葉だけ・行き方は同じ）
-- ・社内FAQ「スマホの文字を大きくしたい」とホームのお知らせの行き方を「右上のアイコン →［設定 →］→ 文字の大きさ」に
-- 🚨 文は画面（App.tsx の右上のメニュー「設定 →」・pages/AccountSettings.tsx の「文字の大きさ」）から拾っている

begin;

update public.faq_answers
   set body = replace(body, '「アカウント設定」', '「設定」'), updated_at = now()
 where id in ('a55d94ac-3544-4556-97fe-48bc59f9a26d', '40828b36-7b92-463e-95f3-8b581be41d11')
   and body like '%「アカウント設定」%';

update public.faq_answers
   set body = $faq$右上の丸いアイコン（名前の頭文字）を押し、［設定 →］を開いて、「文字の大きさ」で［大きめ］か［特大］を選んでください。そのスマホだけに効きます。元に戻すときは［標準］を押してください。

パソコンでは、キーボードの［Ctrl］と［＋］で大きくできます（元に戻すのは［Ctrl］と［0］）。$faq$,
       updated_at = now()
 where id = '8d054597-ede0-453f-97fc-5509951887b3';

update public.announcements
   set body = $ann$右上の丸いアイコン（名前の頭文字）を押し、［設定 →］を開いて、「文字の大きさ」で［大きめ］か［特大］を選んでください。
そのスマホだけに効きます。元に戻すときは［標準］を押してください。$ann$
 where id = '2296c1cf-589b-4f3f-be06-444dcc59d24b';

commit;
