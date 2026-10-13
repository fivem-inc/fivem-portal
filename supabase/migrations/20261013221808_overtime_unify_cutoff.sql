-- 休暇申請の「時間調整」「調整休（時間外調整休・振替休日）」を残業申請にまとめる区切り（2026-10-13 ユーザー確定・10/16 から）
-- ・区切りの日は app_settings の overtime_unify_cutoff（"YYYY-MM-DD"）。画面もこの関数も同じ値を読む
--   🚨 夜中に設定を書き換える cron は使わない（失敗に気づけない・JST/UTC の取り違え）。日付で判定するので、その日が来れば自動で切り替わる
--   戻すときは値を遠い未来にするだけ（deploy 不要）
-- ・区切り以降の日を含む「調整休（時間外調整休・振替休日）」の休暇申請は受け付けない（画面でも止める・ここは最後の砦）
--   🚨 有休奨励日の回答（調整休・種類なし）と、残業の「提案」の受諾（purpose='残業調整（提案受諾）'・今まで0件）は止めない
--   🚨 attendance_exceptions（時間調整タブ）には入れない（管理者の勤怠入力など、ほかの入口も同じ表を使うため）。タブは画面で止める
begin;

insert into public.app_settings (key, value, updated_at)
values ('overtime_unify_cutoff', '"2026-10-16"'::jsonb, now())
on conflict (key) do update set value = excluded.value, updated_at = now();

create or replace function public.overtime_unify_cutoff()
returns date
language sql
stable
security definer
set search_path to 'public'
as $function$
  select nullif(value #>> '{}', '')::date from app_settings where key = 'overtime_unify_cutoff'
$function$;
revoke execute on function public.overtime_unify_cutoff() from public;
revoke execute on function public.overtime_unify_cutoff() from anon;
grant execute on function public.overtime_unify_cutoff() to authenticated;

create or replace function public.enforce_leave_adjust_moved()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_cut date := public.overtime_unify_cutoff();
begin
  if v_cut is null then return new; end if;
  if new.leave_type is distinct from '調整休' or new.chosei_sub_type is null then return new; end if;
  if coalesce(new.purpose, '') = '残業調整（提案受諾）' then return new; end if;
  if coalesce(new.status, '') in ('cancelled', 'rejected', 'withdrawn') then return new; end if;
  if exists (select 1 from unnest(public.shift_adjust_days(new.leave_dates, new.start_date, new.end_date)) d where d >= v_cut) then
    raise exception 'LEAVE_ADJUST_MOVED: %以降の調整休（時間外調整休・振替休日）は「残業申請」で申請してください', to_char(v_cut, 'FMMM/FMDD')
      using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;
revoke execute on function public.enforce_leave_adjust_moved() from public;
revoke execute on function public.enforce_leave_adjust_moved() from anon;
revoke execute on function public.enforce_leave_adjust_moved() from authenticated;

drop trigger if exists trg_enforce_leave_adjust_moved on public.leave_requests;
create trigger trg_enforce_leave_adjust_moved
  before insert or update of leave_type, chosei_sub_type, leave_dates, start_date, end_date on public.leave_requests
  for each row execute function public.enforce_leave_adjust_moved();

commit;
