-- 従業員番号（2026-10-21 ユーザー確定・docs/計画-残業の表で見る.md）
-- 給与計算で使っている番号。並びに使うのは「残業の受理済み一覧（表で見る・名前順）」と「勤務変更のタブの名前順」だけ。
-- 人を選ぶ・探す一覧は今までどおり役職の順。
-- ・profiles に列を足すだけ（新しい表ではないので GRANT は今のまま）。読めるのは今の profiles と同じ（ログインしている人は全員分）＝ユーザー確定（番号なのでよい）
-- ・書けるのは今の profiles の決まりどおり管理者だけ
-- ・空白だけの値は入れさせない（空は null）。空でない値は人ごとに1つ（重ならない）
-- 🚨 番号と名前の対応（最初の一括入力）は公開のリポジトリに書かない。本番の DB にだけ入れる

alter table public.profiles add column if not exists employee_no text;

alter table public.profiles drop constraint if exists profiles_employee_no_not_blank;
alter table public.profiles add constraint profiles_employee_no_not_blank
  check (employee_no is null or (employee_no = btrim(employee_no) and length(employee_no) between 1 and 20));

create unique index if not exists profiles_employee_no_key on public.profiles (employee_no) where employee_no is not null;

comment on column public.profiles.employee_no is '従業員番号（給与計算の番号）。残業の表で見る・勤務変更のタブの名前順に使う。空は null';
