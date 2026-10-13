-- 実績報告の受理がまだのとき、上長へ毎朝お知らせする（2026-10-13 ユーザー確定）
-- ・届いてから何日たったら知らせるかを、残業の管理画面（設定）で変えられるようにする（既定 2日）
-- ・知らせるのは Edge Function remind-overtime-pending-review（毎朝 9:05）。今ある「受理がまだの残業申請が◯件あります」に件数を足すだけ
--   （新しい通知の種類は作らない＝通知設定の overtime:pending_review の ON/OFF・宛先の決まりがそのまま効く）
begin;

alter table public.overtime_settings
  add column if not exists report_review_remind_days integer not null default 2;
alter table public.overtime_settings
  drop constraint if exists overtime_settings_report_review_remind_days_check;
alter table public.overtime_settings
  add constraint overtime_settings_report_review_remind_days_check check (report_review_remind_days between 1 and 14);
comment on column public.overtime_settings.report_review_remind_days is
  '実績報告（status=reported）が届いてから何日たっても受理されていなければ、上長へ毎朝お知らせするか（1〜14日）';

commit;
