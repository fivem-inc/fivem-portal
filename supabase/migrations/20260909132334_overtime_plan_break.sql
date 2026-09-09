-- ============================================================
-- 2026-09-09  残業の調整案に「休憩の手修正」を持たせる
-- ============================================================
-- きっかけ：イベントの日は休憩の取り方が普段と違う（ユーザー指摘）。
-- 通常の残業申請には「休憩（手修正）／自動計算に戻す」があるのに、
-- 調整案は自動計算しかできず、見込みが実際とずれていた。
--
-- 🚨 null ＝ 自動計算（申請フォームの break_manual=false と同じ意味）。
--    数値が入っていたら手修正。申請フォームと同じ考え方にそろえてある。

alter table overtime_plan_items
  add column if not exists break_minutes int;

comment on column overtime_plan_items.break_minutes is
  '休憩の手修正（分）。null は自動計算。申請フォームの break_manual / break_minutes と同じ意味';
