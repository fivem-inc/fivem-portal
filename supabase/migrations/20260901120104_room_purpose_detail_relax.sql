-- ============================================================
-- 場所予約：パーソナルの詳細に「リラク」を足す（2026-09-01 ユーザー指示）
--
-- なぜ別のファイルにするのか:
--   20260901114035 は**すでに本番へ適用済み**。適用したファイルを後から書き換えても
--   流れ直さないため、追加は必ず新しいファイルにする。
--
-- 🚨 これ以降の追加は、**画面（基本設定 → 用途詳細）から社員が足せる**。
--    ここに書き足す必要はない。SQLで足すのは、画面がまだ本番に出ていない今回だけ。
--
-- ロールバック手順:
--   delete from room_purpose_details where purpose = 'パーソナル' and name = 'リラク';
--   ※ その名前で予約が入ったあとは消さず、画面から「隠す」にすること
-- ============================================================

insert into room_purpose_details (purpose, name, sort_order) values
  ('パーソナル', 'リラク', 3)
on conflict (purpose, name) do nothing;

-- 確認用:
--   select purpose, name, sort_order, active
--     from room_purpose_details order by purpose, sort_order;
