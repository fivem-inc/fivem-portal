-- ログインしていない人（anon）から、本人を確かめずにデータを返す関数の実行権限を外す（2026-09-19）
-- きっかけ：退職の2段目の下調べで、公開されている anon キーだけで overtime_planned_totals を呼ぶと
--   全スタッフの user_id と残業の分数が返ることを本番で確認した（以前からの状態・今日の変更が原因ではない）。
-- ・対象は「security definer かつ anon が実行でき、中で auth.uid() などの確認をしていない」16本。
--   🚨 faq_public_contact / faq_public_data / faq_public_event_log / faq_public_log は**意図して anon に開けている**（お客様向けFAQ）ので触らない
-- ・ログインしている人（authenticated）と service_role には明示的に付け直す（public 経由の権限を外しても使えるように）
-- ・🚨 表のポリシー（roles=public）の中で使われている関数もある（overtime_role_rank 等）。anon がその表を読むと
--   「関数の権限がない」エラーになるが、ログイン前の画面はそれらの表を読まない（ログインしている人には影響しない）
-- ・room_check_conflict は場所予約の担当の関数。ユーザー判断で事後報告（引き継ぎ「次にやること 6」）
do $$
declare
  f text;
  fns text[] := array[
    'public.admin_setup_alerts()',
    'public.any_active_safety_check()',
    'public.get_database_usage_mb()',
    'public.get_storage_usage_mb()',
    'public.overtime_can_choose_calendar(uuid)',
    'public.overtime_planned_totals(date)',
    'public.overtime_role_rank(uuid)',
    'public.overtime_role_rank_target(uuid)',
    'public.overtime_threshold_for(uuid)',
    'public.overtime_threshold_over(date)',
    'public.role_acts_as(uuid)',
    'public.role_rank(uuid)',
    'public.room_check_conflict(uuid, timestamp with time zone, timestamp with time zone, boolean, uuid)',
    'public.safety_check_is_active(uuid)',
    'public.safety_choice_is_urgent(uuid, text)',
    'public.scheduled_reminder_status(uuid, integer, integer)'
  ];
begin
  foreach f in array fns loop
    execute format('revoke execute on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated, service_role', f);
  end loop;
end $$;
