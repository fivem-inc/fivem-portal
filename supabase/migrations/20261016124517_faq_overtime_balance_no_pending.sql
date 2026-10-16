-- 社内FAQ：合計時間数で、未確定のものが無いときの出し方（2026-10-16 ユーザー確定 案1）
-- 未確定のものが無いときは「確定」の見出しを付けず、合計の数字だけを出す（前と同じ見た目）。
-- 20261016122525 で入れた2件の文を、それに合わせて直す
-- 🚨 文は画面（components/OvertimeBalanceView・部門集計の「数字の見かた」）とそろえている

begin;

update public.faq_answers
   set body = replace(body,
         '未確定のものが無いときは、「確定」だけが表示されます。',
         '未確定のものが無いときは、合計の数字だけが表示されます（すべて確定した時間です）。'),
       updated_at = now()
 where id = 'ca651837-1d4b-4e2d-8ed8-11f4e384f1cd'
   and body like '%未確定のものが無いときは、「確定」だけが表示されます。%';

update public.faq_answers
   set body = replace(body,
         '未確定のものが無い方は確定だけを表示します。',
         '未確定のものが無い方は、合計の数字だけを表示します（すべて確定した時間です）。'),
       updated_at = now()
 where id = '2bb8005b-d701-4068-8983-1f9c36680064'
   and body like '%未確定のものが無い方は確定だけを表示します。%';

commit;
