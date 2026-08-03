-- ========================================
-- 安否確認：応援要請パターン(support)の追加と定型文の見直し
--   ・support＝「本日◯◯校の応援に入れる人はいますか」という“お願い”。
--     安否確認と違い全員に答える義務はないため、発信時のリマインド既定は0回（画面側で制御）。
--   ・地震でも出勤可否を聞きたいケースがあるため safety4 の定型文を追加。
--   ・「本日出勤予定でない方にも…全員回答を」は、出勤予定がない人に出勤可否を聞く形になっていて
--     矛盾していたため文言を修正。
-- ========================================

alter table safety_check_templates drop constraint if exists safety_check_templates_pattern_check;
alter table safety_check_templates add constraint safety_check_templates_pattern_check
  check (pattern in ('safety3','safety4','attendance2','support'));

alter table safety_checks drop constraint if exists safety_checks_pattern_check;
alter table safety_checks add constraint safety_checks_pattern_check
  check (pattern in ('safety3','safety4','attendance2','support'));

-- 「緊急の出勤確認」の文言を修正（出勤予定がない人に出勤可否だけ聞くのは不自然だったため）
update safety_check_templates
   set body = '緊急のご連絡です。本日の出勤の可否を確認します。本日出勤予定の方は、出勤の可否をお知らせください。予定がない方も、応援に入れる場合はお知らせください。'
 where title = '緊急の出勤確認';

-- 追加の定型文（冪等：同じタイトルがあれば入れない）
insert into safety_check_templates (title, body, pattern, sort_order)
select v.title, v.body, v.pattern, v.sort_order
from (values
  ('地震の安否確認（出勤可否つき）', '地震が発生しました。皆さんの安否と、本日の出勤の可否を確認します。ボタンで回答してください。', 'safety4', 2),
  ('応援要請（急な人手不足）', '本日 ◯◯校 △時〜△時 で応援に入っていただける方はいらっしゃいますか。難しい場合は「今回は難しいです」で構いません。', 'support', 5)
) as v(title, body, pattern, sort_order)
where not exists (select 1 from safety_check_templates t where t.title = v.title);
