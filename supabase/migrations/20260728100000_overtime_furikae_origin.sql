-- 振替休日（furikae_off）の振替元を保存する列を追加。
-- 振替元の勤務日（実際に出勤した日）と、その日の勤務校（シフトから自動取得・手修正可）。
-- 記録のみ（残高に影響しない）。additive で既存行に影響なし。
alter table overtime_reports
  add column if not exists furikae_origin_date date,
  add column if not exists furikae_origin_location text;
