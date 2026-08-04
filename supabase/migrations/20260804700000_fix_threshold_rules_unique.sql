-- 役職ごと・個人ごとのしきい値が「追加する」で保存できない不具合の修正
--
-- 症状：there is no unique or exclusion constraint matching the ON CONFLICT specification
-- 原因：一意性を「部分ユニークインデックス（where ... is not null）」で作ったため、
--       PostgREST の upsert(onConflict) がターゲットにできなかった。
--       CLAUDE.md（2026-07-24）に同じ教訓があるのに再発させた。
--
-- 部分インデックスにする必要はなかった。PostgreSQL では NULL 同士は重複扱いされないので、
-- 通常のユニーク制約でも「役職ルールは role_title ごとに1件（user_id は NULL が並ぶ）」
-- 「個人ルールは user_id ごとに1件（role_title は NULL が並ぶ）」が成立する。

drop index if exists public.overtime_threshold_rules_role_uniq;
drop index if exists public.overtime_threshold_rules_user_uniq;

alter table public.overtime_threshold_rules
  drop constraint if exists overtime_threshold_rules_role_title_key,
  drop constraint if exists overtime_threshold_rules_user_id_key;

alter table public.overtime_threshold_rules
  add constraint overtime_threshold_rules_role_title_key unique (role_title),
  add constraint overtime_threshold_rules_user_id_key unique (user_id);
