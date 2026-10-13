-- 打刻の確認：段階0（2026-10-13・計画は docs/計画-打刻の確認の改善.md）
--
-- 1) 「業務をしていました」と答えた日に残業申請が出たら、確認と自動で結び付ける（不具合1）
--    🚨 前は画面の「打刻ズレ」のときしか結び付けておらず、「業務をしていました」のあとに申請しても
--       経理の画面の「※残業の報告待ち」が消えず、打刻の確認で開けた締め後の許可も開いたままだった。
--    申請の依頼の自動結び付け（trg_overtime_insert_link_appreq・20260926184323）と同じ形。
--    1件フォーム・表入力・管理者の代理入力、どこから出しても効く。
--    🚨 残業申請の中心の表への insert に付くので、例外を出す経路を作らない（update 2つだけ）。
--    🚨 after insert だけ（差し戻しからの再提出は同じ行の update なので要らない）。
-- 2) 打刻の確認の関数のうち、ログインしていない人（anon）からも呼べたものを外す
--    （中で本人かを確かめているので悪用はできないが、決まりどおり明示して外す）

begin;

create or replace function public.link_clock_inquiry_on_report_insert()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
begin
  if new.entry_type is distinct from 'manual' or new.status = 'cancelled' then
    return null;
  end if;

  with linked as (
    update overtime_clock_inquiry_days d
       set result_report_id = new.id
      from overtime_clock_inquiries i
     where i.id = d.inquiry_id
       and i.user_id = new.applicant_id
       and i.status = 'answered'
       and d.answer = 'worked'
       and d.result_report_id is null
       and (d.work_date = new.work_date or d.work_date = new.furikae_origin_date)
    returning d.work_date
  )
  -- 打刻の確認で自動で開けた締め後の許可を閉じる（結び付いた日だけ）
  update overtime_submission_grants g
     set revoked_at = now()
   where g.user_id = new.applicant_id
     and g.source = 'clock_inquiry'
     and g.revoked_at is null
     and g.work_date in (select work_date from linked);

  return null;
end;
$$;
revoke execute on function public.link_clock_inquiry_on_report_insert() from public;
revoke execute on function public.link_clock_inquiry_on_report_insert() from anon;
revoke execute on function public.link_clock_inquiry_on_report_insert() from authenticated;

drop trigger if exists trg_overtime_insert_link_clock_inquiry on public.overtime_reports;
create trigger trg_overtime_insert_link_clock_inquiry
  after insert on public.overtime_reports
  for each row execute function public.link_clock_inquiry_on_report_insert();

-- anon から外す（authenticated はそのまま）
revoke execute on function public.answer_overtime_clock_inquiry(uuid, jsonb, text) from anon;
revoke execute on function public.link_clock_inquiry_result(uuid, uuid) from anon;
revoke execute on function public.cancel_own_clock_only_report(uuid) from anon;
revoke execute on function public.oci_can_view(uuid, uuid) from anon;

commit;
