-- ============================================================
-- 2026-09-26  残業：「開始が遅い理由」「早く終わる理由」で押した事情を保存する列（(144) の続き）
-- ============================================================
-- ✅ ユーザー確定（2026-09-26）
--   ・4択の上3つ（時間調整・イベント・会議・大掃除など・出張・直行直帰・在宅など）は種別としては「調整遅出／調整早退」のまま（種別は増やさない）
--   ・ただし札とカレンダーの表記は押した事情で変える：
--       時間調整 → 調整遅出／調整早退（そのまま）・Google カレンダーは 遅出(調整)／早退(調整)（そのまま）
--       イベント・会議・大掃除など → 遅出(イベント・会議など)／早退(イベント・会議など)
--       出張・直行直帰・在宅など   → 遅出(出張・在宅など)／早退(出張・在宅など)
--   ・そのために押した値を保存する。null＝押していない／遅刻・早退／過去の申請（＝今までどおり「調整」の表記）
-- 🚨 計算・受理の流れ・RLS は変えない。列を2つ足すだけ。

alter table public.overtime_reports
  add column if not exists late_situation  text check (late_situation  in ('adj', 'event', 'telework')),
  add column if not exists early_situation text check (early_situation in ('adj', 'event', 'telework'));

comment on column public.overtime_reports.late_situation is
  '「開始が遅い理由」で押した事情（adj=時間調整／event=イベント・会議・大掃除など／telework=出張・直行直帰・在宅など）。'
  '種別は late_start_adj のまま。札・カレンダー・Slack の表記に使う。null＝遅刻・未選択・過去の申請';
comment on column public.overtime_reports.early_situation is
  '「早く終わる理由」で押した事情（adj／event／telework）。種別は early_end_adj のまま。表記に使う。null＝早退・未選択・過去の申請';

-- 確認用:
--   select column_name from information_schema.columns where table_name = 'overtime_reports' and column_name like '%_situation';
