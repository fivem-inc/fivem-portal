-- 休職の表（staff_leaves）から、使わなくなった2つの列を消す（2026-11-02 ユーザー指示・引き継ぎ (328) の2段目）
--   board_opt_in   … 連絡板のお知らせを受け取るか（休職 段5 で「スマホの通知」1つ＝push_on に決めて使わなくなった・2026-10-21）
--   board_asked_at … それを本人に聞いた日時
-- 🚨 画面が読むのをやめたのは 2026-10-23（lib/staffLeave の COLS から外した）。古い画面が残っている間は消さない決まりで、10/30 以降に入れる予定だった
-- 🚨 入れる前に本番で確かめた（2026-11-02）：DB の関数・ビュー・決まり（ポリシー）・Edge Function・画面のどこからも使っていない
alter table public.staff_leaves drop column if exists board_opt_in;
alter table public.staff_leaves drop column if exists board_asked_at;
