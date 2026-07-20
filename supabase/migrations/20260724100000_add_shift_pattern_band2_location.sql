-- ========================================
-- 曜日パターンに「2つ目の勤務時間帯（外出・戻り・テレワーク）」と「校」を追加
-- 勤務表Excelは1日が2行構成で、2段目に第2の時間帯や校が入るため
-- すべて追加のみ・NULL許容なので既存データは無傷
-- ========================================
alter table weekly_shift_patterns
  add column if not exists start_time2 time,
  add column if not exists end_time2 time,
  add column if not exists location text;

-- 第2時間帯も開始・終了は両方入れるか両方NULL
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'wsp_band2_both'
  ) then
    alter table weekly_shift_patterns
      add constraint wsp_band2_both check ((start_time2 is null) = (end_time2 is null));
  end if;
end $$;
