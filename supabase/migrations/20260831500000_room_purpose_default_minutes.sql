-- ============================================================
-- 場所予約：用途ごとの「最初に入る長さ」を決められるようにする
--            （2026-08-31 ユーザー指示：プライベートは30分にしたい）
--
-- なぜ列を足すのか:
--   これまでは minutes の先頭を既定にしていた。
--   プライベートは「25、30、50」の順に並べたいが、最初に入るのは30分にしたい。
--   🚨 並び順を「30、25、50」に変えて先頭を既定にする手もあるが、
--      ボタンの並びが数字順でなくなって読みにくい。
--      **並び順と既定は別のこと**なので、別の列で持つ。
--
-- 既定値:
--   null = これまでどおり minutes の先頭を使う。
--   プライベートだけ 30 を入れる。
--
-- 🚨 minutes に入っていない値を既定にしない。
--    ボタンが選択状態にならず、押しても変わらないように見える。
--    画面側でも、一覧に無い値は選べないようにしてある。
--
-- ロールバック手順:
--   alter table room_purpose_durations drop column default_minutes;
-- ============================================================

alter table room_purpose_durations
  add column if not exists default_minutes int;

update room_purpose_durations
   set default_minutes = 30, updated_at = now()
 where purpose = 'プライベート'
   and 30 = any (minutes);

-- 確認用:
--   select purpose, minutes, default_minutes, allow_free
--     from room_purpose_durations order by purpose;
