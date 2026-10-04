-- ============================================================
-- 2026-10-04  社内FAQ：マネージャー以上がパソコンで管理画面を使えることを足す（ユーザー確定「案A（短く）」）
-- ============================================================
-- ・(62) 管理画面をマネージャー以上に開く（2026-09-15）の説明がまだ無かった
-- ・どのタブを開くかは管理者が決めて時期で変わるので、タブの名前は書かない（ユーザー確定）
-- ・対象は roles.is_manager_plus の役職（2026-10-04 実測＝マネージャー・社長・管理者）。🚨 役職名を直書きしない
--   （判定 can_manage_admin_tab と同じ「マネージャー以上」。一般・リーダー・フロア責任者・パートには出さない）
-- 🚨 IDは固定。何度流しても増えない（質問・回答は on conflict update、対象役職は delete→insert）
-- 🚨 valid_from を必ず入れる（空だと下書き扱いで誰にも出ない）。role_id はトリガーが役職名から入れる

insert into faq_topics (id, audience, category, question, keywords, is_published, is_featured, needs_review, sort_order)
values
  ('b0000000-0000-4000-8000-000000000927', 'internal', 'アカウント・通知',
   'パソコンで管理画面（⚙️ 管理）を使えるのは誰？',
   array['管理画面', '管理', '⚙️', 'パソコン', 'PC', 'マネージャー', '設定', 'シフト管理', 'FAQ管理'], true, false, false, 1045)
on conflict (id) do update
  set category = excluded.category,
      question = excluded.question,
      keywords = excluded.keywords,
      is_published = excluded.is_published,
      sort_order = excluded.sort_order;

insert into faq_answers (id, topic_id, valid_from, body)
values
  ('b0000000-0000-4000-8000-000000000937', 'b0000000-0000-4000-8000-000000000927', '2026-10-04',
   E'マネージャー以上の方は、管理者が開いた項目だけ、パソコンから管理画面（⚙️ 管理）を使えます。スマホでは開けません。どの項目が使えるかは、管理者にご確認ください。')
on conflict (id) do update set body = excluded.body, valid_from = coalesce(faq_answers.valid_from, excluded.valid_from);

delete from faq_answer_targets where answer_id = 'b0000000-0000-4000-8000-000000000937'::uuid;

insert into faq_answer_targets (answer_id, role_title)
select 'b0000000-0000-4000-8000-000000000937'::uuid, r.name
  from roles r
 where r.is_manager_plus;
