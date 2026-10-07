-- 略した「有給」を「有休」にそろえる（2026-10-07 ユーザー確定）。社内FAQ の文だけ。
-- 🚨 変えないもの：種類名「有給休暇」／「バースデー休暇（有給）」（説明はそのまま有給）／保存されている値（leave_type など）／
--    有休奨励日の目印（reason='【有給奨励日】'・purpose='有給奨励日'）
-- 🚨 検索の言葉には昔の書き方も残す（「有給」で探す人がいるため・2026-10-06 の有休奨励日と同じ）

begin;

update public.faq_topics
   set question = replace(question, '有給申請', '有休申請'),
       keywords = array(select distinct k from unnest(coalesce(keywords, array[]::text[]) || array['有給申請', '有休申請']) as k)
 where id = '46cfd067-645c-482c-9891-fb6d4c1a3732' and question like '%有給申請%';

update public.faq_answers
   set body = replace(replace(replace(body, '有給申請', '有休申請'), '有給取得', '有休取得'), '有給の申請', '有休の申請')
 where id in ('92279c99-77cc-4c92-b5db-5c54c64b9792', 'a8fc780e-ffca-4d26-87fa-099689781ec1', '852d3bf3-d67f-4692-87b8-bb370c338c35')
   and (body like '%有給申請%' or body like '%有給取得%' or body like '%有給の申請%');

commit;
