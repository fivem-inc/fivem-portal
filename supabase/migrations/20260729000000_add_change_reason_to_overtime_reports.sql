-- 残業 実績報告の「予定から変わった理由」を本体に保存（承認者・本人・履歴で表示するため）。
-- 履歴(overtime_report_history.change_reason)にも残るが、本体列は表示用に持つ（最新の変更理由）。
alter table public.overtime_reports
  add column if not exists change_reason text;
