-- こどもシフト表の「3F・5F で動ける人」（共通の人）の置き場所と行の種類（2026-10-06 ユーザー確定）。
-- 設計は docs/計画-大人シフト表.md §5・§5-2。表の作りは 20261006161238（kind='pool'・use_pool）で済んでいる。ここは中身の行だけ。
--
-- ・置き場所：四条本校の kind='pool'（こどもの表だけ）。1日1マスに「3F・5F で動ける人」の行を1つ置き、人ごとに何時から・何時まで
-- ・行の種類 'pool'：🚨 active=false にする。今の画面の「＋行を足す」のボタンに出さないため（共通の人の入力は専用の画面で行う）。
--   保存の関数（kids_shift_check_items）は種類があるかどうかだけを見るので、active=false でも保存できる
-- 🚨 今のこどもの画面（2026-10-06 の版）は kind='column'／'head'／'daynote' だけを表に出すので、この行を足しても表は変わらない

begin;

insert into public.kids_shift_row_kinds (key, label, has_class, has_groups, has_people, issue_mode, sort_order, active, boards)
values ('pool', '3F・5F で動ける人', false, false, true, 'full', 900, false, array['kids'])
on conflict (key) do nothing;

insert into public.kids_shift_places (board, kind, school, floor, label, sort_order, active)
select 'kids', 'pool', '四条本校', null, '四条本校 3F・5F で動ける人', 35, true
 where not exists (select 1 from public.kids_shift_places p where p.board = 'kids' and p.kind = 'pool' and p.school = '四条本校');

commit;
