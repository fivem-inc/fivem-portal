-- シフト調整：古い「案を保存」（1つの日に1つだけ保存する仕組み）を片付ける（計画 docs/計画-シフト調整.md §6 の⑤・2026-10-01 ユーザー承認）
--
-- 2026-09-25 から「案」（shift_adjust_plans・何通りでも作れる・確認した）に置き換わり、画面からは呼ばれていない。
-- 2026-10-01 実測：shift_adjust_saved_plans 0件／client・Edge Function からの参照 0／ほかの DB 関数からの参照 0／cron 0／外部キー 0
-- 消すもの：トリガー trg_zz_shift_adjust_clear_saved_plan（shift_adjust_slots）・関数2つ・表1つ。
-- 🚨 戻すときは git の履歴（この表と関数を作った migration）から起こし直す。記録は0件なので失うものは無い

drop trigger if exists trg_zz_shift_adjust_clear_saved_plan on public.shift_adjust_slots;
drop function if exists public.trg_shift_adjust_clear_saved_plan();
drop function if exists public.shift_adjust_save_plan(uuid, jsonb, boolean, boolean, text, text, timestamp with time zone, boolean);
drop table if exists public.shift_adjust_saved_plans;
