-- FAQ（よくある質問）を管理画面の「役職・機能権限管理」で切り替えられるようにする。
--
-- これまで表示可否がコードに直書き（社長・管理者のみ）で、マネージャーに広げたいときに
-- 開発が必要だった。他の機能と同じ feature_permissions に乗せることで、管理画面の
-- チェックだけで公開範囲を変えられるようにする。
--
-- 初期値は現状と同じ「社長・管理者のみON」。この時点では誰の見え方も変わらない。
--
-- 🚨 FeaturePermissionsTab は「保存ボタンを押したとき」に全役職×全機能を upsert する作りなので、
--    ここで seed しておかないと、管理画面で一度保存するまで行が存在しない
--    （＝チェックを入れる前の状態が「全員OFF」になり、社長すら見られなくなる）

-- faq     … FAQを使えるか（各ページの「💡 FAQ」ボタン・アバターメニューから開ける）
-- faq_nav … ナビバーにもボタンを出すか
--           ナビはボタンが並ぶ場所なので「使えるようにはしたいがナビには出したくない」が実際にある。
--           faq が OFF の人には効かない（押した先で弾かれるボタンを出さないため）
insert into public.feature_permissions (role_id, feature_key, enabled)
select r.id, k.key, r.name in ('社長', '管理者')
from public.roles r
cross join (values ('faq'), ('faq_nav')) as k(key)
on conflict (role_id, feature_key) do nothing;
