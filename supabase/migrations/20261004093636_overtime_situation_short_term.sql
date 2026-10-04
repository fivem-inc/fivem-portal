-- ============================================================
-- 2026-10-04  残業：「開始が遅い理由」「早く終わる理由」に「短期・イベントなど」を足す
-- ============================================================
-- ✅ ユーザー確定（2026-10-04・案A）
--   ・「イベント・会議・大掃除など」を2つに分ける：
--       新しい値 short_term … 短期・イベントなど → 遅出(短期・イベントなど)／早退(短期・イベントなど)
--       今の値   event      … 会議・大掃除など   → 遅出(会議・大掃除など)／早退(会議・大掃除など)
--   ・それまで event で保存された記録は3件だけで、どれも短期ではなかった（大掃除2件・ローテーション変更1件）。
--     なので値 event を「会議・大掃除など」に引き継ぐ。**記録は書き換えない**
--   ・種別は今までどおり「調整遅出／調整早退」。計算・受理の流れ・RLS は変えない
-- 🚨 ここでやるのは、保存できる値に short_term を足すことだけ（check 制約の付け直し）

alter table public.overtime_reports drop constraint if exists overtime_reports_late_situation_check;
alter table public.overtime_reports drop constraint if exists overtime_reports_early_situation_check;
alter table public.overtime_reports
  add constraint overtime_reports_late_situation_check  check (late_situation  in ('adj', 'short_term', 'event', 'telework')),
  add constraint overtime_reports_early_situation_check check (early_situation in ('adj', 'short_term', 'event', 'telework'));

comment on column public.overtime_reports.late_situation is
  '「開始が遅い理由」で押した事情（adj=時間調整／short_term=短期・イベントなど／event=会議・大掃除など／telework=出張・直行直帰・在宅など）。'
  '種別は late_start_adj のまま。札・カレンダー・Slack の表記に使う。null＝遅刻・未選択・過去の申請。'
  'event は 2026-10-03 までは「イベント・会議・大掃除など」の意味だった（2026-10-04 に short_term を分けた）';
comment on column public.overtime_reports.early_situation is
  '「早く終わる理由」で押した事情（adj／short_term／event／telework）。種別は early_end_adj のまま。表記に使う。null＝早退・未選択・過去の申請';

-- 確認用:
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.overtime_reports'::regclass and conname like '%situation%';
