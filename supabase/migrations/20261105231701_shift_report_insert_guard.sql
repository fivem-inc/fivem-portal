-- 勤務変更（shift_reports）の段0：画面を通さずに「受理済み」などを入れられる穴を塞ぐ（2026-11-05）
-- ・ポリシー applicant_insert は submitted_by = auth.uid() だけで、status も applicant_id も見ていない。
--   → 本人が最初から status='confirmed'（受理済み）で入れられた／受理の権限が無い人がほかの方の名前で入れられた（画面からはできない・不審な行は0件）
-- ・reviewer_confirm に WITH CHECK が無く、申請先の人は状態を何にでも変えられた
-- ・事前申請（計画 docs/計画-勤務変更-事前申請.md）を足す前に塞ぐ
-- 決まり（ログインしている人だけ見る＝service_role・cron は今までどおり。管理者は今までどおり）
--   INSERT：ほかの方の名前で入れるのは受理できる人（is_approver）だけ（画面の canProxy と同じ）。
--           状態は pending だけ。confirmed は「代わりに入れて、申請先＝自分」（画面の自己受理）のときだけ
--   UPDATE：状態を confirmed・returned に変えるのは、申請先＝自分の受理できる人だけ（自分の報告は不可）。
--           状態が変わらない更新（申請先の付け替え・管理者の修正）と pending・resubmitted・cancelled は今までどおりポリシーに任せる
-- 🚨 事前申請の状態を足すときは、ここにも足す

create or replace function public.enforce_shift_report_status()
returns trigger
language plpgsql
security invoker
set search_path to 'public'
as $function$
begin
  if auth.uid() is null then return new; end if;  -- service_role・cron
  if is_admin() then return new; end if;

  if tg_op = 'INSERT' then
    if new.applicant_id is distinct from auth.uid() and not is_approver() then
      raise exception 'ほかの方の勤務変更は、受理できる方だけが代わりに報告できます' using errcode = '42501';
    end if;
    if new.status = 'pending' then return new; end if;
    if new.status = 'confirmed'
       and new.applicant_id is distinct from auth.uid()
       and new.reviewer_id = auth.uid()
       and is_approver() then
      new.confirmed_by := auth.uid();
      new.confirmed_at := coalesce(new.confirmed_at, now());
      return new;
    end if;
    raise exception '勤務変更の報告は「確認待ち」で送ってください（受理は申請先の方が行います）' using errcode = '42501';
  end if;

  -- UPDATE
  if new.status is not distinct from old.status then return new; end if;
  if new.status in ('confirmed', 'returned') then
    if old.reviewer_id = auth.uid()
       and new.reviewer_id = auth.uid()
       and new.applicant_id is distinct from auth.uid()
       and old.status in ('pending', 'resubmitted', 'confirmed')
       and is_approver() then
      if new.status = 'confirmed' then
        new.confirmed_by := auth.uid();
        new.confirmed_at := coalesce(new.confirmed_at, now());
      end if;
      return new;
    end if;
    raise exception '受理・差し戻しは申請先の方が行います' using errcode = '42501';
  end if;
  return new;
end;
$function$;

revoke execute on function public.enforce_shift_report_status() from public;
revoke execute on function public.enforce_shift_report_status() from anon;

drop trigger if exists trg_shift_report_status on public.shift_reports;
create trigger trg_shift_report_status
  before insert or update on public.shift_reports
  for each row execute function public.enforce_shift_report_status();
