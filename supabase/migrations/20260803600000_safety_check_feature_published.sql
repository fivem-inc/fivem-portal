-- ========================================
-- 安否・緊急連絡の公開設定を「機能別 表示権限」に登録する
--   初期状態＝全公開OFF・リーダー以上ON（＝先行公開）。
--   周知の準備ができてから管理画面で「全公開」をONにする運用にする。
--
--   ⚠️ 安否確認は役職別のトグル（feature_permissions）は使わない。
--      役職で絞ると「その役職の人に安否確認が届かない」ことになり本末転倒なため、
--      公開/非公開の切り替えだけで運用する。
-- ========================================

update app_settings
   set value = value || '{"safety_check": false}'::jsonb
 where key = 'feature_published'
   and not (value ? 'safety_check');

update app_settings
   set value = value || '{"safety_check": true}'::jsonb
 where key = 'feature_published_leader'
   and not (value ? 'safety_check');

-- 行が無い場合に備えて（通常は既にある）
insert into app_settings (key, value)
select 'feature_published', '{"safety_check": false}'::jsonb
where not exists (select 1 from app_settings where key = 'feature_published');

insert into app_settings (key, value)
select 'feature_published_leader', '{"safety_check": true}'::jsonb
where not exists (select 1 from app_settings where key = 'feature_published_leader');
