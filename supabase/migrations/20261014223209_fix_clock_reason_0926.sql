-- 打刻ズレから調整早退に直した記録（9/26・1件）の理由の文を、早退の記録に合う文に直す（2026-10-14 ユーザー確定 A）
-- ・20261013232456 で種類を「打刻ズレ → 調整早退（−1:00）」に直したが、理由の文が打刻ズレの決まり文句
--   「残業ではありません（理由：打刻ミス　調整20:00退勤）」のまま残っていた（10/10 の分は直っている）
-- ・対象は 20261013232456 で直した2件のうちの 9/26 の1件だけ（理由がその決まり文句のときだけ直す）。履歴に残す（前回と同じ形）
begin;

insert into public.overtime_report_history (report_id, changed_by, change_kind, change_summary, change_reason, changes, snapshot)
select r.id, 'aad2b6cf-2e62-4c8b-9e36-40922c48c13f', 'admin_edit', '理由を修正',
       '種類を調整早退に直したのに、理由の文が打刻ズレの決まり文句のままだったため',
       jsonb_build_object('reason', jsonb_build_object('old', r.reason, 'new', '理由：調整のため早退（20:00退勤・打刻ミス）')),
       to_jsonb(r)
  from public.overtime_reports r
 where r.id = '9bf54b1f-0209-4059-8d48-05d1c898ab25'
   and r.application_types = array['early_end_adj']::text[]
   and r.reason = '残業ではありません（理由：打刻ミス　調整20:00退勤）';

update public.overtime_reports
   set reason = '理由：調整のため早退（20:00退勤・打刻ミス）', updated_at = now()
 where id = '9bf54b1f-0209-4059-8d48-05d1c898ab25'
   and application_types = array['early_end_adj']::text[]
   and reason = '残業ではありません（理由：打刻ミス　調整20:00退勤）';

commit;
