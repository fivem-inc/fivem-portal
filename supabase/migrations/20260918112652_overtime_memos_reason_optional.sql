-- ============================================================
-- 2026-09-18  残業のメモ：理由を必須にしない（どの種類でも）
-- ============================================================
-- ユーザー指示（2026-09-18・実機を触ったあと）：「理由は必須でなくてもいい。何を選択しても」。
-- それまでは 打刻忘れ・打刻ズレ以外は理由が必須だった（overtime_memos_reason_required）。
-- 🚨 メモは申請ではないので、理由が空でも困らない（申請画面の理由欄は今までどおり申請側の検証が見る）。
--
-- ロールバック手順:
--   alter table public.overtime_memos add constraint overtime_memos_reason_required
--     check (kind in ('missed_clock', 'clock_only') or char_length(btrim(reason)) > 0);

alter table public.overtime_memos
  drop constraint if exists overtime_memos_reason_required;
