-- profiles.role_id を、role_title（正）に合わせて揃える。
--
-- 【背景（2026-09-09 に実測して見つけた）】
-- profiles には役職を表す列が2つある：
--   ・role_title … 文字列。**こちらが正**（権限判定はこの名前で roles を引く。
--                   client/src/hooks/useAuth.ts の fetchPermsForRole）
--   ・role_id    … roles への外部キー。**いまどこからも使われていない**
-- 実測したところ、50人中 **26人でこの2つが食い違って**いた（role_id が未設定の人も1人）。
--
-- 🚨 いまは実害がない（role_id を読んでいる場所が無いため）。
--    しかし将来 role_id を使い始めた瞬間に、26人の役職が変わったことになり、
--    権限が静かに入れ替わる。実害が出る前に揃えておく。
--
-- 🚨 role_title を書き換えるのではなく、role_id を role_title に合わせる。
--    逆にすると「いま正しく動いている権限」を書き換えることになり、危険。
--    ここは**使われていない列を、使われている列に合わせるだけ**の作業。

update profiles p
   set role_id = r.id
  from roles r
 where r.name = p.role_title
   and p.role_id is distinct from r.id;

-- 🚨 role_title が roles に無い人（もしいれば）は、この update の対象外＝そのまま残る。
--    その場合は名前の対応が壊れているということなので、
--    role_id を推測で埋めず、人が確認する（2026-09-09 時点では0人）。

comment on column profiles.role_id is
  'roles への参照。🚨 権限判定は role_title（文字列）を見ており、この列は現状どこからも使われていない。2026-09-09 に role_title へ合わせて揃えた。今後 rename_role() が両方をまとめて更新する';
