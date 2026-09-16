-- 🚨 至急：残業・時間管理の「打刻ズレ」（clock_only）が、作った日から一度も保存できていなかった（2026-09-16）
--
-- ・スタッフからの報告：「9/1（火）退勤打刻忘れの連絡が来て報告したが、弾かれた」
--   画面に出ていた文：new row for relation "overtime_reports" violates check constraint
--                     "overtime_reports_application_types_check"
-- ・原因：種別の検査は 2026-07-28（20260728000000_overtime_fullday.sql）に作られ、
--   「打刻ズレ」は 2026-08-05（20260805000000_clock_inquiry.sql）に画面へ足したのに、
--   🚨 **検査の一覧に clock_only を足し忘れていた**。画面は ['clock_only'] で保存するので必ず弾かれる
-- ・本番の実測（2026-09-16）：clock_only の記録は 0 件（残業報告は全部で92件）＝8/5 から誰も記録できていない
-- 🚨 直すのは種別の一覧だけ。終日の種別（時間外調整休・振替休日・欠勤）の決まり
--   （overtime_reports_fullday_single_type）は触らない＝打刻ズレは今までどおり他の種別と一緒に付けられない扱いにしない

alter table public.overtime_reports
  drop constraint if exists overtime_reports_application_types_check;

alter table public.overtime_reports
  add constraint overtime_reports_application_types_check
  check (application_types <@ array[
    'overtime', 'early_start', 'tardiness', 'early_leave', 'holiday_work', 'location_change',
    'late_start_adj', 'early_end_adj', 'chosei_off', 'furikae_off', 'absence',
    'clock_only'  -- 打刻ズレ（打刻が遅れただけ・差分0・合計時間数は増えも減りもしない）
  ]::text[]);

comment on constraint overtime_reports_application_types_check on public.overtime_reports is
  '残業・時間管理の種別の一覧。🚨 client/src/lib/overtimeTypes.ts の OvertimeType と必ずそろえる（2026-09-16 に clock_only を追加）';
