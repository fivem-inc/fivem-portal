-- 調整休（振替休日）の「振替元の勤務日」に日付ごとの校を持たせる列。
-- leave_locations（休暇日の校）と同じ JSON.stringify(Record<日付,校>) 形式のTEXT。
-- 例: {"2026-07-17":"四条本校","2026-07-18":"西陣校"}
-- reason の文章（振替休日（振替元：…））には校を混ぜず、データとして別列に持つ。
-- NULL許容＝既存申請は校なしのまま（後方互換）。
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS chosei_origin_locations TEXT;
