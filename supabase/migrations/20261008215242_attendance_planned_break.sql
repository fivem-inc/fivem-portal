-- 勤怠カレンダーの予定に「勤務の中で取る休憩（分）」を持たせる（2026-10-08 ユーザー確定・UI/UX とシニアエンジニアの2体でレビュー済み）
-- きっかけ：予定の休憩が労働基準法の最低に足りないと登録を止めるようにした（同日）。
--          時間帯が3つに分かれていて授業の時刻を動かせない日は、時間帯を割って休憩を入れられず（3つまで）、上司が予定を登録できなかった。
-- ・時間帯を増やさず、勤務の中で取る休憩の分数だけを持つ（法律が求めているのは勤務の途中に必要な分数の休憩を取ること）。
--   いつ取るかは備考に書いてもらう（画面で必須にする）
-- ・null＝今までどおり（自動の休憩だけ）。勤務変更へは「未報告の一覧」から引き継ぎ、報告の休憩に足す（本人は入力しない）
-- ・🚨 時間帯の数の決まり（3つまで）・勤務変更の表・管理者の修正の関数は変えない

alter table public.attendance_exceptions
  add column if not exists planned_break_minutes integer
  check (planned_break_minutes is null or planned_break_minutes between 1 and 180);

comment on column public.attendance_exceptions.planned_break_minutes is
  '勤務の中で取る休憩（分）。時間帯ごとの自動の休憩に足す。null＝自動の休憩だけ。いつ取るかは notes（備考）に書く';
