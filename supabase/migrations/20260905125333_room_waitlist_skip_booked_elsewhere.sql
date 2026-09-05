-- ============================================================
-- 見送りに「別枠で予約」の印を足す（2026-09-05 ユーザー指示）
--
-- 背景：「この日は見送る」の理由はこれまで**自由な文章だけ**だった。
--       実際にいちばん多いのは「別の枠で予約が取れたので今回はいらない」で、
--       これは数えたり、一覧でひと目で見分けたりしたい情報。
--
-- 🚨 **理由の文章に「別枠で予約」と書いて後から文字で見分ける方式は採らない。**
--    表記ゆれ（別枠／別ワク／別の枠…）で数えられなくなる。
--    2026-09-02 に用途詳細で同じ判断をしている（「メモ欄に書く」案を見送った）。
--
-- 🚨 **繰り上げの判定には影響しない。**
--    room_promote_waitlist_at は room_waitlist_skips に「行があるか」しか見ておらず、
--    reason も、この新しい列も読まない。だから**RPCの作り直しは不要**
--    （create or replace もしない＝古い版で上書きする事故が起きない）。
--
-- 🚨 既存の行は false で入る（＝ふつうの見送り）。実際そうだったので、
--    後から埋め直す必要はない。
--
-- 取り消すとき：
--   alter table room_waitlist_skips drop column if exists booked_elsewhere;
-- ============================================================

alter table room_waitlist_skips
  add column if not exists booked_elsewhere boolean not null default false;

comment on column room_waitlist_skips.booked_elsewhere is
  '別の枠で予約が取れたので見送った、という印（2026-09-05〜）。'
  '担当別の予約一覧では、この印だけを「見送り：別枠で予約」と出し、'
  'reason（自由な文章）は出さない。';

-- ============================================================
-- 確認（1文ずつ流すこと。まとめて流すと最後の結果しか返らない）
--
--   -- 列ができたか（1行返れば成功）
--   select column_name, data_type, column_default, is_nullable
--     from information_schema.columns
--    where table_name = 'room_waitlist_skips' and column_name = 'booked_elsewhere';
--
--   -- 既存の行がすべて false になっているか（false の件数＝全件、null は0件）
--   select count(*) as 全件,
--          count(*) filter (where booked_elsewhere is false) as 印なし,
--          count(*) filter (where booked_elsewhere) as 別枠で予約,
--          count(*) filter (where booked_elsewhere is null) as null件数
--     from room_waitlist_skips;
-- ============================================================
