-- ============================================================
-- 2026-10-26  社内FAQ：管理画面「受理済みの変更」（経理向け・管理者だけ）
-- ============================================================
-- ・計画 docs/計画-経理向け変わった申請の一覧.md。画面 components/admin/ChangeLogTab.tsx
-- ・見せる相手は管理者だけ（このタブは管理者だけが開ける）
-- 🚨 画面の決まり（確認の印・締め後・バックアップから）を変えたらこの文も直す
-- 🚨 IDは固定。何度流しても増えない。valid_from を必ず入れる（空だと下書き扱いで誰にも出ない）

begin;

insert into faq_topics (id, audience, category, question, keywords, is_published, is_featured, needs_review, sort_order)
values
  ('d9cb70af-758b-4257-a594-49f9b07ea9e9', 'internal', '残業・時間管理',
   '給与のデータを取ったあとに、申請が変わったかを確かめるには？（管理者）',
   array['受理済みの変更', '変更の記録', '給与計算', '経理', '確認済み', '締め後', '削除の記録', 'Excel'], true, false, false, 342)
on conflict (id) do update
  set category = excluded.category,
      question = excluded.question,
      keywords = excluded.keywords,
      is_published = excluded.is_published,
      sort_order = excluded.sort_order;

insert into faq_answers (id, topic_id, valid_from, body)
values
  ('bc1c56ba-442b-4246-85bd-f335e5fdb831', 'd9cb70af-758b-4257-a594-49f9b07ea9e9', '2026-10-26',
   $faq$管理画面の「📋 受理済みの変更」で確かめます（管理者だけが見られます）。
残業・休暇・勤務変更・交通費・勤怠カレンダーの予定が、あとから変わったときの記録が、給与期間ごとに並びます。

【見方】
・最初は「給与の数字にかかわるもの」（受理済みになった・受理済みが取消・削除・差し戻し・修正された・勤怠カレンダーの予定）だけが出ます。受理の前の動きは、いちばん下にたたまれています
・［人ごと］［時系列］で並べ方を切り替えられます。種類（残業・休暇など）でも絞れます
・残業は、給与の数字がどれだけ変わったか（例：残業 +1:15）も出ます

【未確認の印】
・残業・勤務変更の［表で見る］の Excel、一覧の Excel・CSV、交通費の CSV（給与期間の16日から出したとき）、この画面の Excel を出すと、その時刻が記録されます。それより後の変更に「未確認」が付きます
・［確認済みにする］を押すと、画面に出ているいちばん新しい変更までを確認済みにします。押し間違えたときは［1つ前に戻す］で戻せます

【赤い枠・札】
・締め（支給月の17日）を過ぎてからの変更には「締め後」の札が付きます。締めたあとの期への変更は、上の赤い枠に別に出ます
・「バックアップから」の札の行は、記録を始める前（10/16〜10/26）の分を、毎日のバックアップを見比べて作り直したものです。1日の間の細かい動きと、した人が分からないことがあります

いちばん下には「削除の記録」（申請を［削除］したときの理由と、消す前の内容）があります。$faq$)
on conflict (id) do update set body = excluded.body, valid_from = coalesce(faq_answers.valid_from, excluded.valid_from);

delete from faq_answer_targets where answer_id = 'bc1c56ba-442b-4246-85bd-f335e5fdb831'::uuid;
insert into faq_answer_targets (answer_id, role_title) values ('bc1c56ba-442b-4246-85bd-f335e5fdb831'::uuid, '管理者');

commit;
