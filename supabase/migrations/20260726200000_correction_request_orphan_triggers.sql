-- ========================================
-- 修正依頼の孤児対策トリガ
--   correction_requests.target_id は物理FKを張れない（3テーブルのどれかを指すため）。
--   対象申請が削除されたら、紐づく修正依頼も一緒に消して孤児を残さない。
--   ※ 追加のみ（トリガ追加）。列変更なし＝既存データ無傷。
-- ========================================

create or replace function delete_orphan_correction_requests() returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from correction_requests
  where target_type = tg_argv[0] and target_id = old.id;
  return old;
end;
$$;

drop trigger if exists trg_leave_correction_cleanup on leave_requests;
create trigger trg_leave_correction_cleanup
  after delete on leave_requests
  for each row execute function delete_orphan_correction_requests('leave');

drop trigger if exists trg_shift_correction_cleanup on shift_reports;
create trigger trg_shift_correction_cleanup
  after delete on shift_reports
  for each row execute function delete_orphan_correction_requests('shift');

drop trigger if exists trg_overtime_correction_cleanup on overtime_reports;
create trigger trg_overtime_correction_cleanup
  after delete on overtime_reports
  for each row execute function delete_orphan_correction_requests('overtime');
