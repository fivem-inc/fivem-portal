-- ============================================================
-- 2026-10-13  残業：「開始が遅い理由」「早く終わる理由」に「練習・試合・遠征など」を足す
-- ============================================================
-- ✅ ユーザー確定（2026-10-13・案B）：試合・遠征の日に言葉を選べない（スタッフからの質問・実際の申請を確かめた）
--   新しい値 match … 練習・試合・遠征など → 遅出(練習・試合・遠征など)／早退(練習・試合・遠征など)
--   種別は今までどおり「調整遅出／調整早退」。計算・受理の流れ・RLS は変えない。記録は書き換えない
-- 🚨 ここでやるのは、保存できる値に match を足すことだけ（check 制約の付け直し）
--    表記は client/src/lib/overtimeTypes.ts・gcal-sync・send-overtime-slack の SITUATION_SUFFIX（3か所管理）
begin;

alter table public.overtime_reports drop constraint if exists overtime_reports_late_situation_check;
alter table public.overtime_reports drop constraint if exists overtime_reports_early_situation_check;
alter table public.overtime_reports
  add constraint overtime_reports_late_situation_check  check (late_situation  in ('adj', 'short_term', 'match', 'event', 'telework')),
  add constraint overtime_reports_early_situation_check check (early_situation in ('adj', 'short_term', 'match', 'event', 'telework'));

comment on column public.overtime_reports.late_situation is
  '「開始が遅い理由」で押した事情（adj=時間調整／short_term=短期・イベントなど／match=練習・試合・遠征など／event=会議・大掃除など／telework=出張・直行直帰・在宅など）。'
  '種別は late_start_adj のまま。札・カレンダー・Slack の表記に使う。null＝遅刻・未選択・過去の申請。'
  'event は 2026-10-03 までは「イベント・会議・大掃除など」の意味だった（2026-10-04 に short_term を分けた）。match は 2026-10-13 から';
comment on column public.overtime_reports.early_situation is
  '「早く終わる理由」で押した事情（adj／short_term／match／event／telework）。種別は early_end_adj のまま。表記に使う。null＝早退・未選択・過去の申請';

commit;
