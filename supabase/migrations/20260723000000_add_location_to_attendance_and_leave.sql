-- 欠勤・休暇に「校（勤務校）」を持たせる列を追加。
--
-- attendance_exceptions.location … 欠勤・遅刻・早退・時間調整の校（1レコード=1日なのでスカラー）
-- leave_requests.leave_locations … 日付ごとの校。JSON.stringify(Record<日付,校>) 形式のTEXT
--   例: {"2026-08-29":"四条本校","2026-08-30":"西陣校"}
--   ※leave_dates（日付配列のJSON文字列）の形式は変えない。既存のJSON.parse→string[]前提の
--     コードを壊さないため、校の対応表は別列に持つ。
-- どちらもNULL許容＝既存データは校なしのまま（後方互換）。
ALTER TABLE attendance_exceptions ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS leave_locations TEXT;
