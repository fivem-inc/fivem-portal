-- 出張報告から申請：機能を出す日と社内FAQ（2026-10-14 ユーザー確定：10/16（金）から・文もユーザー確定）
-- ・app_settings trip_apply_start = 2026-10-16：「出張の申請がまだの日」の一覧・出張報告のあとの「下書きを作成しました」・
--   出張報告の画面の説明の3行目が、この日から出る（日付で判定するので、その日が来れば自動で切り替わる）
-- ・社内FAQ：新しく1件（10/16 から）／「出張・園指導のとき、報告はどうする？」は 10/16 から1行足した版に（前の版は 10/15 まで）
-- 🚨 FAQ の文は画面（lib/tripPending.ts・OvertimePage・ShiftReportPage・BusinessTripReport）から拾っている。変えるときは一緒に直す
begin;

update public.app_settings set value = '"2026-10-16"'::jsonb, updated_at = now() where key = 'trip_apply_start';

insert into public.faq_topics (id, question, keywords, category, audience, is_published, sort_order)
values (
  '6f2b1d1e-3c55-4c1a-9b8e-2a7d4e9c1f10',
  '出張の日の残業申請（パートの方は勤務変更）は？',
  array['出張', '園指導', '出張報告', '残業申請', '勤務変更', '下書き', '受理なし', 'シフト表'],
  '出張報告',
  'internal',
  true,
  15
)
on conflict (id) do nothing;

insert into public.faq_answers (id, topic_id, body, valid_from)
values (
  '0d8a4c3b-7e21-4f6a-8c59-3b1e2f7a9d24',
  '6f2b1d1e-3c55-4c1a-9b8e-2a7d4e9c1f10',
  $faq$出張報告（到着か終了）を送ると、その日の残業申請（パートの方は勤務変更）の下書きができます。残業申請（勤務変更）のページの「📋 出張の申請がまだの日」から開き、実際に勤務した開始・終わりの時刻と理由を入れて申請してください。日付と勤務地（出張先）は入っています。

・到着・終了の時刻は報告を送った時刻なので、勤務の時刻としては入りません。
・泊まりがけの出張は、到着の日から終了の日まで1日ずつ出ます。
・決定済みのシフト表（大人の出張・こどもの園指導）どおりの出張で、シフトの時間内なら、受理を待たずに確定します（上長へはお知らせだけが届きます）。シフト表に無い・行き先が違う・残業や早出がある日は、いつもどおり上長の受理が要ります。
・パートの方の勤務変更は、いつも確認者の確認が要ります。$faq$,
  '2026-10-16'
)
on conflict (id) do nothing;

-- 「出張・園指導のとき、報告はどうする？」：前の版は 10/15 まで、10/16 から1行足した版
update public.faq_answers set valid_until = '2026-10-15', updated_at = now()
 where id = '5fad76df-4657-43da-9652-37bac1c520c0' and valid_until is null;

insert into public.faq_answers (id, topic_id, body, valid_from)
select '9b3e5f71-2c84-4d6e-a1f7-6c2d8e4b0a39', a.topic_id,
       a.body || chr(10) || chr(10) || '到着・終了の報告を送ると、その日の残業申請（パートの方は勤務変更）の下書きができます。',
       '2026-10-16'
  from public.faq_answers a
 where a.id = '5fad76df-4657-43da-9652-37bac1c520c0'
on conflict (id) do nothing;

commit;
