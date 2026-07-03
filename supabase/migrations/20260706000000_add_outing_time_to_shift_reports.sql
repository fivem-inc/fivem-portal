-- 勤務変更申請：外出・戻り時間（通常シフト／実際の勤務それぞれに任意で記録できるようにする）
alter table public.shift_reports
  add column if not exists original_outing_start time,
  add column if not exists original_outing_end   time,
  add column if not exists actual_outing_start   time,
  add column if not exists actual_outing_end     time;
