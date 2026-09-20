-- 退職者の申請期間・2段目の手順3-2（2026-09-20・設計書 §8-5 / §8-6 / §8-7）
-- 退職者専用の役割 retiree に、申請に要る表・関数だけを許す。
-- 🚨 在籍者（authenticated）の権限・ポリシーには一切触らない。足すのは「to retiree」の新しいポリシーだけ。
-- 🚨 いま retiree になる人は0人（手順5の Hook を入れて、かつ期限内の退職者が現れて初めて使われる）。
-- 元に戻すとき：末尾のコメントの「戻し版」を流す。

-- ───────────────────────────────────────────────
-- 0. auth スキーマについて（🚨 2026-09-20 実測でわかったこと）
--    `grant usage on schema auth to retiree` は **書いても効かない**。
--    auth スキーマの持ち主は supabase_admin で、postgres は usage を「もらっている」だけ
--    （人に配る権限が無い）。PostgreSQL は権限が足りない grant を**エラーではなく警告**で
--    素通りさせるので、書いても黙って何も起きない。
--    → それでも retiree のポリシーは動く。ポリシーの中の auth.uid() は、ポリシーを作った時点で
--      関数が決まっており、読むときにスキーマの usage を確かめ直さないため（本番で実測済み）。
--    → 画面（PostgREST）が auth.uid() を直接呼ぶことは無いので、これで足りる。
-- ───────────────────────────────────────────────

-- ───────────────────────────────────────────────
-- 1. 設定の表（読むだけ・全行）
--    申請の画面が読む：役職／機能の権限／選択肢／会社カレンダー／通知の設定／
--    残業のカレンダー表示の規則／リーダーの担当
-- ───────────────────────────────────────────────
do $mig$
declare t text;
begin
  foreach t in array array['roles','feature_permissions','master_options','company_calendar',
                           'notification_settings','overtime_calendar_choice_rules','leader_assignments']
  loop
    execute format('grant select on public.%I to retiree', t);
    execute format('create policy retiree_select on public.%I for select to retiree using (true)', t);
  end loop;
end $mig$;

-- ───────────────────────────────────────────────
-- 2. app_settings は「公開してよい鍵」だけ
--    🚨 連絡板・DM の宛先設定（board_* / dm_*）は退職者には見せない
-- ───────────────────────────────────────────────
grant select on public.app_settings to retiree;
create policy retiree_select on public.app_settings for select to retiree
  using (key in ('feature_published','feature_published_leader','feature_published_president',
                 'idle_logout','push_banner_config','gcal_calendar_mode'));

-- ───────────────────────────────────────────────
-- 3. profiles は「列を絞って」「本人と在籍の承認者だけ」
--    🚨 メールアドレス・IP・最終ログイン・登録日時などは列ごと許さない
-- ───────────────────────────────────────────────
grant select (id, name, role_title, role_id, employment_type, is_active, sort_order,
              group_names, leave_request_enabled, approval_status,
              retire_date, retiree_access_until)
  on public.profiles to retiree;

create policy retiree_select on public.profiles for select to retiree
  using (
    id = auth.uid()
    or (is_active and exists (
          select 1 from public.roles r
           where r.id = profiles.role_id
             and (r.is_approver or r.is_manager_plus or r.is_board_approver)))
  );

-- ───────────────────────────────────────────────
-- 4. 交通費（本人の行）
--    🚨 在籍者も update のポリシーを持っていない（作成と閲覧だけ）ので、retiree も同じにする
-- ───────────────────────────────────────────────
grant select, insert on public.expenses to retiree;
create policy retiree_select on public.expenses for select to retiree using (user_id = auth.uid());
create policy retiree_insert on public.expenses for insert to retiree with check (user_id = auth.uid());

-- ───────────────────────────────────────────────
-- 5. 残業（本人の行）
--    条件は在籍者のポリシー（overtime_*_own）から、本人の行に関わる部分だけを写している
-- ───────────────────────────────────────────────
grant select, insert, update on public.overtime_reports to retiree;
create policy retiree_select on public.overtime_reports for select to retiree
  using (applicant_id = auth.uid());
create policy retiree_insert on public.overtime_reports for insert to retiree
  with check (submitted_by = auth.uid() and applicant_id = auth.uid() and entry_type = 'manual');
create policy retiree_update on public.overtime_reports for update to retiree
  using (applicant_id = auth.uid() and entry_type = 'manual'
         and status = any (array['requested','request_confirmed','reported','returned']))
  with check (applicant_id = auth.uid() and entry_type = 'manual'
         and status = any (array['requested','request_confirmed','reported','returned']));

grant select, insert, update, delete on public.overtime_report_segments to retiree;
create policy retiree_all on public.overtime_report_segments for all to retiree
  using (exists (select 1 from public.overtime_reports r
                  where r.id = overtime_report_segments.report_id and r.applicant_id = auth.uid()))
  with check (exists (select 1 from public.overtime_reports r
                  where r.id = overtime_report_segments.report_id and r.applicant_id = auth.uid()));

grant select, insert on public.overtime_report_history to retiree;
create policy retiree_select on public.overtime_report_history for select to retiree
  using (changed_by = auth.uid()
         or exists (select 1 from public.overtime_reports r
                     where r.id = overtime_report_history.report_id and r.applicant_id = auth.uid()));
create policy retiree_insert on public.overtime_report_history for insert to retiree
  with check (changed_by = auth.uid());

grant select on public.overtime_submission_grants to retiree;
create policy retiree_select on public.overtime_submission_grants for select to retiree
  using (user_id = auth.uid());

grant select, insert on public.overtime_submission_grant_requests to retiree;
create policy retiree_select on public.overtime_submission_grant_requests for select to retiree
  using (user_id = auth.uid());
create policy retiree_insert on public.overtime_submission_grant_requests for insert to retiree
  with check (user_id = auth.uid());

grant select, insert, update, delete on public.overtime_plan_items to retiree;
create policy retiree_all on public.overtime_plan_items for all to retiree
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ───────────────────────────────────────────────
-- 6. 勤務変更報告（本人の行）
-- ───────────────────────────────────────────────
grant select, insert, update on public.shift_reports to retiree;
create policy retiree_select on public.shift_reports for select to retiree
  using (applicant_id = auth.uid());
create policy retiree_insert on public.shift_reports for insert to retiree
  with check (submitted_by = auth.uid() and applicant_id = auth.uid());
create policy retiree_update on public.shift_reports for update to retiree
  using (applicant_id = auth.uid() and status = any (array['pending','resubmitted','returned']))
  with check (applicant_id = auth.uid() and status = any (array['pending','resubmitted','cancelled']));

grant select, insert on public.shift_report_history to retiree;
create policy retiree_select on public.shift_report_history for select to retiree
  using (changed_by = auth.uid()
         or exists (select 1 from public.shift_reports s
                     where s.id = shift_report_history.report_id and s.applicant_id = auth.uid()));
create policy retiree_insert on public.shift_report_history for insert to retiree
  with check (changed_by = auth.uid());

-- ───────────────────────────────────────────────
-- 7. 申請の依頼（本人が出した・本人あて）
--    条件は在籍者の appreq_insert と同じ（機能の権限を見る）
-- ───────────────────────────────────────────────
grant select, insert, update on public.application_requests to retiree;
create policy retiree_select on public.application_requests for select to retiree
  using (requester_id = auth.uid() or recipient_id = auth.uid());
create policy retiree_insert on public.application_requests for insert to retiree
  with check (requester_id = auth.uid()
    and exists (select 1
                  from public.feature_permissions fp
                  join public.roles r on r.id = fp.role_id
                  join public.profiles p on p.role_title = r.name
                 where fp.feature_key = 'application_request' and fp.enabled and p.id = auth.uid()));
create policy retiree_update on public.application_requests for update to retiree
  using (requester_id = auth.uid() or recipient_id = auth.uid());

-- ───────────────────────────────────────────────
-- 8. 修正依頼（読むだけ。出す・取り下げるのは RPC）
-- ───────────────────────────────────────────────
grant select on public.correction_requests to retiree;
create policy retiree_select on public.correction_requests for select to retiree
  using (requester_id = auth.uid());

-- ───────────────────────────────────────────────
-- 9. 通知（ベル）
--    🚨 他人あての insert は「本人が見られる在籍の承認者」あてだけ
-- ───────────────────────────────────────────────
grant select, insert, update on public.notifications to retiree;
create policy retiree_select on public.notifications for select to retiree
  using (user_id = auth.uid());
create policy retiree_update on public.notifications for update to retiree
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy retiree_insert on public.notifications for insert to retiree
  with check (created_by = auth.uid()
    and (user_id = auth.uid()
         or exists (select 1 from public.profiles pr
                      join public.roles r on r.id = pr.role_id
                     where pr.id = notifications.user_id and pr.is_active
                       and (r.is_approver or r.is_manager_plus or r.is_board_approver))));

-- ───────────────────────────────────────────────
-- 10. 通常シフト（本人）
-- ───────────────────────────────────────────────
grant select on public.weekly_shift_patterns to retiree;
create policy retiree_select on public.weekly_shift_patterns for select to retiree
  using (user_id = auth.uid());

-- ───────────────────────────────────────────────
-- 11. 関数（設計書 §8-6 で決めた5本だけ）
-- ───────────────────────────────────────────────
grant execute on function public.touch_last_sign_in() to retiree;
grant execute on function public.set_overtime_show_on_calendar(uuid, boolean) to retiree;
grant execute on function public.my_study_sessions(date) to retiree;
grant execute on function public.submit_correction_request(text, uuid, text, jsonb, text) to retiree;
grant execute on function public.withdraw_correction_request(uuid) to retiree;

-- 戻し版（この migration を取り消すとき）:
--   do $rb$ declare r record; begin
--     for r in select schemaname, tablename, policyname from pg_policies
--              where schemaname = 'public' and 'retiree' = any (roles)
--     loop execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename); end loop;
--   end $rb$;
--   revoke all on all tables in schema public from retiree;
--   revoke all on all functions in schema public from retiree;
