-- ============================================================
-- 場所予約：毎週の枠そのものにメモを持たせる（2026-09-04 ユーザー承認）
--
-- 背景：キャンセル待ちの一覧は「枠（曜日・時間・場所・担当）」ごとに並ぶ。
--   その枠についての申し送り（例：「17:40以降なら受け入れ可」「◯◯さん優先」）を
--   書いておく場所が無かった。
--
-- 🚨 既にある room_recurrences.memo は使えない。あれは**月次更新
--    （room_extend_recurrence）が、これから作る各回の予約メモにコピーする元**で、
--    運用の申し送りを書くと今後の全部の回のメモに入ってしまう。
--    そこで**回にはコピーしない**別の列 slot_memo を足す。
--
-- ロールバック手順:
--   alter table room_recurrences drop column if exists slot_memo;
-- ============================================================

alter table room_recurrences
  add column if not exists slot_memo text;

comment on column room_recurrences.slot_memo is
  '枠そのものへの申し送り（2026-09-04〜）。🚨 memo と違い、生成する回の予約メモにはコピーしない';

-- 確認用:
--   select column_name from information_schema.columns
--    where table_name='room_recurrences' and column_name='slot_memo';
