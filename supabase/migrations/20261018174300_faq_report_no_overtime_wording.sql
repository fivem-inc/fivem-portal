-- 社内FAQ：残業がなかった日の実績報告を「できます」から「してください」に（2026-10-18 ユーザー確定）
-- 🚨 文は残業のページのカード（申請の下の一言）・注意事項とそろえている（pages/OvertimePage.tsx）

begin;

update public.faq_answers
   set body = replace(body,
         '③残業が無かった日も「残業なし」で報告できます',
         '③残業しなかった日も「残業なし」で報告してください'),
       updated_at = now()
 where id = '5404c526-60b8-4764-bb62-027debf980f3'
   and body like '%③残業が無かった日も「残業なし」で報告できます%';

commit;
