-- 退職のチェック表：項目を直しても消しても、過去の記録が変わらないようにする
-- （2026-09-21 ユーザー指摘・案H）
--
-- 【指摘】「そもそも修正しても過去のを変更したらだめでは」「削除で消えるのもないよね」
--   まったくそのとおりで、チェック表は**手続きをやった証拠**なので、あとから書き換わってはいけない。
--   いまの作りには穴が2つあった：
--     ① 項目の文字を直すと、**過去の記録の読まれ方まで変わる**
--        （例：「鍵の返却」を「PCの返却」に直すと、鍵を返してもらった記録が
--          「PCの返却を済みにした」と表示され、記録が嘘をつき始める）
--     ② 項目を消すと、外部キーの on delete cascade で**記録も道連れで消える**
--
-- 【直し方】
--   ① 記録するときに、そのとき画面に出ていた文字を**写しておく**（item_label）。
--      これは新しいやり方ではなく、このシステムで既にやっていること
--      （出欠の counted_present も「記録した時点の設定を写す」形になっている）
--   ② 項目とのつながりを切っても記録が残るようにする（cascade → set null）。
--      消えた項目の記録は、写した文字で「削除された項目」として画面に出す
--
-- 🚨 **いま記録は0件**（本番で実測）。写す文字を後から埋める作業が要らない、
--    いちばん安全なタイミングで入れている。1件でも溜まってからだと
--    「当時の文字が分からない記録」が残ってしまう。
--
-- 🚨 残り件数の数え方は**また1文字も直さない**。数え方は retire_checklist_items を軸に
--    「行があれば残りに数えない」なので、項目が消えた記録はそもそも数の対象から外れる
--    （画面の retireRemaining も、朝9時の通知の not exists も同じ）。

-- ── 1. 記録した時点の項目名を写す列 ─────────────
alter table public.retire_checklist_checks
  add column if not exists item_label text;

comment on column public.retire_checklist_checks.item_label is
  'チェックした時点の項目名の写し。🚨 項目の文字をあとから直しても、過去の記録はこの文字のまま。'
  '項目を削除したあとも、この文字で「削除された項目」として表示する';

-- 既存の記録に写しを入れる（本番は0件。ほかの環境のための埋め戻し）
update public.retire_checklist_checks c
   set item_label = i.label
  from public.retire_checklist_items i
 where i.id = c.item_id
   and c.item_label is null;

-- ── 2. 項目を消しても記録が残るようにする ─────────
-- 🚨 item_id は「消えた項目」を表すために null を許す。
--    unique (user_id, item_id) はそのまま残す。PostgreSQL は null どうしを別物として扱うので、
--    消えた項目の記録が1人に何件あっても引っかからない
alter table public.retire_checklist_checks
  alter column item_id drop not null;

alter table public.retire_checklist_checks
  drop constraint if exists retire_checklist_checks_item_id_fkey;

alter table public.retire_checklist_checks
  add constraint retire_checklist_checks_item_id_fkey
  foreign key (item_id) references public.retire_checklist_items(id) on delete set null;

comment on column public.retire_checklist_checks.item_id is
  'どの項目の記録か。🚨 null＝その項目は削除された（記録は item_label の文字で残る）';

-- ─────────────────────────────────────────
-- 取り消すとき
-- ─────────────────────────────────────────
--   alter table public.retire_checklist_checks drop constraint if exists retire_checklist_checks_item_id_fkey;
--   alter table public.retire_checklist_checks
--     add constraint retire_checklist_checks_item_id_fkey
--     foreign key (item_id) references public.retire_checklist_items(id) on delete cascade;
--   -- 🚨 item_id が null の記録が1件でもあると、not null には戻せない。先に消すか埋めること
--   alter table public.retire_checklist_checks alter column item_id set not null;
--   alter table public.retire_checklist_checks drop column if exists item_label;
