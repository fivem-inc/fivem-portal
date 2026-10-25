-- ============================================================
-- 2026-10-26  社内FAQ：振替休日の実績報告（案C・ユーザー確定）
-- ============================================================
-- ・計画 docs/計画-振替休日の実績報告.md。20261026013919_furikae_report_phase に合わせて
-- ・①「残業ページの『調整休・欠勤（終日）』は何？」の2つの版（10/14〜・11/16〜）の「いずれも受理された時点で完了し、実績報告は不要です。」を案Bの文に置き換える
-- ・②新しい問い「振替休日の実績報告とは？いつから押せる？」。見せる相手は ① の 11/16〜の版と同じ役職
-- 🚨 画面の決まり（lib/furikaeReport・OvertimePage の振替休日の報告）を変えたらこの文も直す
-- 🚨 IDは固定。何度流しても増えない。valid_from を必ず入れる（空だと下書き扱いで誰にも出ない）

begin;

update public.faq_answers
   set body = replace(body, 'いずれも受理された時点で完了し、実績報告は不要です。',
                      '時間外調整休と欠勤は、受理された時点で完了します。振替休日は、振替元の日の勤務のあとに実績を報告します（振替元の日を過ぎてから出したときは不要）。休む日と振替元の日は同じ給与期間の中で選びます。'),
       updated_at = now()
 where id in ('00c7e542-d068-455b-a622-cb75385e5bb5'::uuid, 'd301ca58-dc00-44c8-bdb2-4b8a8c2e13be'::uuid)
   and body like '%いずれも受理された時点で完了し、実績報告は不要です。%';

insert into faq_topics (id, audience, category, question, keywords, is_published, is_featured, needs_review, sort_order)
values
  ('07fe7466-9a1c-4b8d-9715-2467858f4bce', 'internal', '残業・時間管理',
   '振替休日の実績報告とは？いつから押せる？',
   array['振替休日', '振替元', '実績報告', '休日出勤', '時間が延びた', '時刻を直す', '取り消し', '給与期間'], true, false, false, 341)
on conflict (id) do update
  set category = excluded.category,
      question = excluded.question,
      keywords = excluded.keywords,
      is_published = excluded.is_published,
      sort_order = excluded.sort_order;

insert into faq_answers (id, topic_id, valid_from, body)
values
  ('3442d31e-7a64-455f-9121-d38716e168c2', '07fe7466-9a1c-4b8d-9715-2467858f4bce', '2026-10-26',
   $faq$振替休日を振替元の日（休日に出勤する日）より前に出したときは、ふつうの事前申請と同じ流れになります。
①受理されると「事前申請 受理済み」になります（自分で受理する方は送った時点で）
②振替元の日の勤務のあとに、残業ページの「履歴・実績報告」の［実績を報告する（振替元 ◯/◯）］から、実際の時間を報告します
③予定どおりなら受理を待たずに確定します。時間が違えば申請先の方が確認します（自分で受理する方はそのまま確定します）
報告するまでは、合計時間数は「見込み」に入ります。

【押せる時刻（振替元の日の当日）】
・［勤務時間が申請と異なりました］… 予定の開始から
・［申請どおりに勤務しました］… 予定の終わりを過ぎてから（延びることがあるため）
翌日からは、どちらもいつでも押せます。上長の受理がまだの間は報告できません。

【取り消し】
休む日・振替元の日のどちらかが来るまでは、ご自分で取り消せます。来たあとは、管理者に取消を依頼してください。

【出せる日】
休む日と振替元の日は、同じ給与期間（16日〜翌月15日）の中で選んでください。振替元の日を過ぎてから出した振替休日は、今までどおり受理された時点で完了します（報告は不要です）。$faq$)
on conflict (id) do update set body = excluded.body, valid_from = coalesce(faq_answers.valid_from, excluded.valid_from);

delete from faq_answer_targets where answer_id = '3442d31e-7a64-455f-9121-d38716e168c2'::uuid;
insert into faq_answer_targets (answer_id, role_title)
select distinct '3442d31e-7a64-455f-9121-d38716e168c2'::uuid, t.role_title
  from faq_answer_targets t
 where t.answer_id = 'd301ca58-dc00-44c8-bdb2-4b8a8c2e13be'::uuid
   and t.role_title is not null;

commit;
