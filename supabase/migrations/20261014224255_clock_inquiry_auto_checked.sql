-- 打刻の確認への答え「業務はしていません」でできた打刻ズレの記録は、できた時点で経理の「確認済み」にする（2026-10-14 ユーザー確定 A）
-- ・経理が聞いて本人が答えた時点で突き合わせは済んでいる。打刻ズレの一覧でもう一度チェックを付ける二度手間をなくす
-- ・チェックが要るのは、経理が聞いていないのに本人が自分で出した打刻ズレだけになる
-- ・確認した人＝その打刻の確認を送った人（overtime_clock_inquiries.sender_id）
-- ・結び付けは link_clock_inquiry_result（result_report_id を入れる）なので、その列が入ったときのトリガーで付ける（どの道から結んでも同じ）
-- ・今ある分（答えでできて、まだ確認済みでない打刻ズレ）も確認済みにする
begin;

create or replace function public.clock_inquiry_auto_checked()
returns trigger
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
begin
  if new.answer = 'not_worked' and new.result_report_id is not null
     and new.result_report_id is distinct from old.result_report_id then
    update overtime_reports o
       set accounting_checked_at = now(),
           accounting_checked_by = (select q.sender_id from overtime_clock_inquiries q where q.id = new.inquiry_id)
     where o.id = new.result_report_id
       and o.application_types = array['clock_only']::text[]
       and o.accounting_checked_at is null;
  end if;
  return new;
end;
$function$;
revoke execute on function public.clock_inquiry_auto_checked() from public;
revoke execute on function public.clock_inquiry_auto_checked() from anon;

drop trigger if exists trg_clock_inquiry_auto_checked on public.overtime_clock_inquiry_days;
create trigger trg_clock_inquiry_auto_checked
  after update of result_report_id on public.overtime_clock_inquiry_days
  for each row execute function public.clock_inquiry_auto_checked();

-- 今ある分
update public.overtime_reports o
   set accounting_checked_at = now(), accounting_checked_by = q.sender_id
  from public.overtime_clock_inquiry_days d
  join public.overtime_clock_inquiries q on q.id = d.inquiry_id
 where d.result_report_id = o.id and d.answer = 'not_worked'
   and o.application_types = array['clock_only']::text[]
   and o.status <> 'cancelled' and o.accounting_checked_at is null;

commit;
