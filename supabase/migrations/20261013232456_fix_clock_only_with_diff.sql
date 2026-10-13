-- 打刻ズレ（残業なし）なのに差が −1:00 になっていた2件の種類を「調整早退（時間調整）」に直す（2026-10-13 ユーザー確定）
-- ・本人が「打刻が遅れただけ」と答えて打刻ズレ（差0）ができたあと、管理画面の［📋修正］で 9:00〜20:00 に直され −1:00 になった。
--   種類が clock_only のままなので、一覧では「残業なし」に見えるのに合計から −1:00 引かれていた
-- ・時間（9:00〜20:00・−1:00）と理由はそのまま。種類だけ early_end_adj（事情は時間調整 adj）にする。履歴に残す
-- ・本番で clock_only かつ差が0でないものはこの2件だけ（2026-10-13 確認）
begin;

insert into public.overtime_report_history (report_id, changed_by, change_kind, change_summary, change_reason, changes, snapshot)
select r.id, 'aad2b6cf-2e62-4c8b-9e36-40922c48c13f', 'admin_edit', '種別を修正（打刻ズレ → 調整早退）',
       '時間を直して差が −1:00 になったのに、種類が打刻ズレ（残業なし）のままだったため',
       jsonb_build_object('application_types', jsonb_build_object('old', '打刻ズレ', 'new', '調整早退')),
       to_jsonb(r)
  from public.overtime_reports r
 where r.id in ('7c3774ce-1e38-462b-91bf-f6d875e5fb4d', '9bf54b1f-0209-4059-8d48-05d1c898ab25')
   and r.application_types = array['clock_only']::text[];

update public.overtime_reports
   set application_types = array['early_end_adj']::text[], early_situation = 'adj', updated_at = now()
 where id in ('7c3774ce-1e38-462b-91bf-f6d875e5fb4d', '9bf54b1f-0209-4059-8d48-05d1c898ab25')
   and application_types = array['clock_only']::text[];

commit;
