-- 退職者の申請期間・3段目の土台（2026-09-20・設計書 §2 §4 §7-5）
-- 画面（ログインの門・ナビ・ホーム）に手を入れる前に、**先に置き場所だけ**作る。
-- 🚨 この migration だけでは利用者に何も起きない（読む側がまだ無い）。

-- ───────────────────────────────────────────────
-- 1. 退職者に出してよい機能（管理画面の「役職・機能権限」に足す「退職者」の列の中身）
--    🚨 feature_permissions は role_id が必須なので使えない（退職者は役職ではない）。
--    🚨 実際に出るのは「ここに ✓ がある」かつ「辞める前の役職で使えていた機能」の**両方**を
--       満たすものだけ（設計書 §4-3 ユーザー確定）。判定は画面側の1か所に置く
-- ───────────────────────────────────────────────
insert into public.app_settings (key, value)
values ('retiree_feature_keys', '{"keys": ["expense", "overtime", "shift_report"]}'::jsonb)
on conflict (key) do nothing;

-- ───────────────────────────────────────────────
-- 2. 退職の手続きのチェック表：項目によっては「どちらか」を選ばせる
--    🚨 Slack のパスワードは「変更した」のか「不要と判断した」のか、あとから追えないと意味がない。
--    🚨 自由に書けるメモ欄は**作らない**。新しいパスワードそのものを書かれる恐れがあるため
--       （2026-09-20 ユーザー確定）
-- ───────────────────────────────────────────────
alter table public.retire_checklist_items
  add column if not exists choices text[];
comment on column public.retire_checklist_items.choices is
  '択一で答える項目の選択肢。null＝ふつうのチェック。🚨 自由記述にはしない（パスワードを書かれないため）';

alter table public.retire_checklist_checks
  add column if not exists choice text;
comment on column public.retire_checklist_checks.choice is
  '択一の項目で選んだ答え。ふつうのチェックでは null';

-- Slack のパスワードの項目を択一にする
update public.retire_checklist_items
   set label = 'Slack のパスワード',
       choices = array['変更した', '不要と判断した']
 where label like 'Slack のパスワード%';

-- 戻し版（この migration を取り消すとき）:
--   update public.retire_checklist_items
--      set label = 'Slack のパスワード変更を検討（変更した／不要と判断した）', choices = null
--    where label = 'Slack のパスワード';
--   alter table public.retire_checklist_checks drop column choice;
--   alter table public.retire_checklist_items  drop column choices;
--   delete from public.app_settings where key = 'retiree_feature_keys';
