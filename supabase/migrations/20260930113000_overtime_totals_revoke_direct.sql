-- 2026-09-30  残業の合計を出す関数を、画面から直接呼べないようにする（全員の残業時間が読めていた穴）
--
-- 見つけた経緯：部門集計の「目安超え」の札を作るときに権限を実測したところ、
--   overtime_planned_totals(date)   … 全員のその期の合計時間数
--   overtime_threshold_over(date)   … 目安を超えた全員と、その時間
--   overtime_threshold_for(uuid)    … 指定した人の目安
-- の3つが authenticated（ログインしている人なら誰でも）に実行権限を持っていた。
-- どれも security definer なので、呼べば RLS を通らずに全員の分が返る。
-- 部門集計は「自分と同じか下の役職だけ」と決めているのに、ここを通れば一般の人でも上の役職の数字まで読める。
--
-- 🚨 画面（client）はこの3つを直接呼んでいない（2026-09-30 grep で確認）。呼んでいるのは
--    overtime_threshold_banner / overtime_threshold_over_visible / notify_overtime_threshold_exceeded（すべて security definer＝持ち主の権限で動く）
--    と、cron の Edge Function remind-overtime-threshold（service_role）だけ。
--    → authenticated から外しても動きは変わらない。service_role には明示して残す。
-- ついでに overtime_visible_roster() の anon の実行権限も外す（中で権限を見ているので空が返るだけだったが、付けておく理由がない）

revoke execute on function public.overtime_planned_totals(date) from public, anon, authenticated;
revoke execute on function public.overtime_threshold_over(date) from public, anon, authenticated;
revoke execute on function public.overtime_threshold_for(uuid) from public, anon, authenticated;
grant execute on function public.overtime_planned_totals(date) to service_role;
grant execute on function public.overtime_threshold_over(date) to service_role;
grant execute on function public.overtime_threshold_for(uuid) to service_role;

revoke execute on function public.overtime_visible_roster() from anon;
