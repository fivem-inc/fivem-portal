-- 大人シフト表の置き場所と行の種類（2026-10-07 ユーザー確定・docs/計画-大人シフト表.md §3）。表の作りは 20261006161238 で済んでいる。ここは中身の行だけ。
--
-- ・置き場所（board='adult'）：大人（本校 6F）＝クラスのマス／出張＝曜日の右の細い列（kind='trip'）／曜日の書き添え
-- ・行の種類：クラス（adult_class）・映像（video）・事務（office）・出張（trip）は大人だけ。P・打合せ・その他はこども・大人の両方
--   P・映像・事務の「終わりが無いときの長さ」は 30分（管理画面で直せる）
-- 🚨 こどもの画面は board='kids' と、boards に kids を含む行の種類だけを読むので、これを足してもこどもの表は変わらない

begin;

insert into public.kids_shift_row_kinds (key, label, has_class, has_groups, has_people, issue_mode, sort_order, active, boards, default_minutes) values
  ('adult_class', 'クラス', true,  false, true, 'full', 5,   true, array['adult'], null),
  ('video',       '映像',   false, false, true, 'full', 110, true, array['adult'], 30),
  ('office',      '事務',   false, false, true, 'full', 120, true, array['adult'], 30),
  ('trip',        '出張',   true,  false, true, 'full', 130, true, array['adult'], null)
on conflict (key) do nothing;

update public.kids_shift_row_kinds set boards = array['kids', 'adult'], default_minutes = coalesce(default_minutes, 30)
 where key = 'private' and not ('adult' = any (boards));
update public.kids_shift_row_kinds set boards = array['kids', 'adult']
 where key in ('meeting', 'other') and not ('adult' = any (boards));

insert into public.kids_shift_places (board, kind, school, floor, label, sort_order, active)
select v.board, v.kind, v.school, v.floor, v.label, v.ord, true
  from (values
    ('adult', 'column',  '四条本校', '6F', '大人（本校 6F）', 10),
    ('adult', 'trip',    null,       null, '出張',            20),
    ('adult', 'daynote', null,       null, '曜日の書き添え',  900)
  ) as v(board, kind, school, floor, label, ord)
 where not exists (
   select 1 from public.kids_shift_places p
    where p.board = v.board and p.kind = v.kind and coalesce(p.school, '') = coalesce(v.school, '') and coalesce(p.floor, '') = coalesce(v.floor, ''));

commit;
