-- 勤怠カレンダーに「休日出勤」「勤務地変更」を追加し、1日の中で校を移動するケースに対応する。
-- 例: 09:00〜12:00 四条本校 → 14:00〜18:00 洛西口校（間の2時間は勤務なし）
--
-- original_location は勤務地変更の「変更前の校（普段の校）」。
-- 校の移動（location の '→' 連結）とは意味が違うため、別の列で持つ。
--
-- work_segments には [{"start":"09:00","end":"12:00","location":"四条本校"}, ...] を入れる。
-- 意味は全種別で「実際に勤務した時間帯」で統一する（遅刻で校を移動した場合も同じ形で持つ）。
-- 既存の location（'四条本校→洛西口校' の連結文字列）と actual_time（先頭の開始時刻）は
-- 一覧表示・Googleカレンダー同期の互換のためこれまで通り埋める。
--
-- ※ 20260613000000 の「本人が自己登録できる」INSERTポリシーは type を明示列挙しているため、
--    holiday_work を足しても一般スタッフが自分の休日出勤を登録できるようにはならない（意図通り）。
--    そちらのポリシーに holiday_work を追加してはいけない。

alter table attendance_exceptions
  drop constraint if exists attendance_exceptions_type_check;

alter table attendance_exceptions
  add constraint attendance_exceptions_type_check
    check (type in ('late', 'early_leave', 'absent', 'late_start', 'early_end', 'holiday_work', 'location_change'));

alter table attendance_exceptions
  add column if not exists work_segments jsonb;

alter table attendance_exceptions
  add column if not exists original_location text;

-- JS から null を渡すと JSON null スカラーになりうるので、配列であることだけは保証する
alter table attendance_exceptions
  drop constraint if exists attendance_exceptions_work_segments_is_array;

alter table attendance_exceptions
  add constraint attendance_exceptions_work_segments_is_array
    check (work_segments is null or jsonb_typeof(work_segments) = 'array');

comment on column attendance_exceptions.work_segments is
  '勤務時間帯の配列 [{start,end,location}]。校を移動する場合や間に勤務しない時間がある場合に使う。単一勤務・全欠勤ではnull。';

comment on column attendance_exceptions.original_location is
  '勤務地変更の「変更前の校（普段の校）」。location（変更後・実際にいる校）と対で使う。それ以外の種別ではnull。';
