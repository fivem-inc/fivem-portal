-- 休暇・残業・勤務変更・交通費の申請を［削除］したときの記録（2026-10-23 ユーザー確定 案A・理由は必須）
--
-- 【背景】
-- 管理画面の［削除］は完全削除で、誰が・いつ・何を・なぜ消したかが何も残らなかった
-- （2026-10-23：同じ日に二重に入っていた休みの片方が、記録の無いまま消えていた）。
-- 備品購入申請には 2026-08-20 から同じ仕組みがある（purchase_request_deletion_log）。それと同じ作り。
--
-- 【設計】
-- ・消す直前（BEFORE DELETE）にトリガーが中身を丸ごと写す。どの画面・どの経路で消しても必ず残る
-- ・親が消えるので record_id に外部キーは張らない（張ると記録も一緒に消える）
-- ・書き込みのポリシー・権限を作らない＝トリガー（SECURITY DEFINER）だけが書ける。あとから人が書き換え・削除できない
-- ・見られるのは管理者だけ（修正依頼のタブの「削除の記録」）
-- ・理由：画面は関数 delete_applications（理由は必須）で消す。関数がその取引の中だけ app.delete_reason に理由を置き、トリガーが読む。
--   🚨 delete_applications は SECURITY INVOKER＝消せるかどうかは今までどおり各表の RLS が決める（権限を広げない）
--   有休奨励日の対象から外したときの自動の削除（理由の欄が【有給奨励日】の休暇）は、理由を自動で入れる
--   休暇を消すと連鎖して消える「休暇から作った残業の行」（source_leave_request_id）も同じ理由で記録される
-- ・掃除：3年より古い記録は毎月1日に消す（記録を貯める仕組みは掃除も一緒に作る決まり）

create table if not exists public.application_deletion_log (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('leave', 'overtime', 'shift', 'expense')),
  record_id uuid not null,
  applicant_id uuid,
  target_date date,
  status text,
  deleted_by uuid,
  deleted_at timestamptz not null default now(),
  reason text,
  snapshot jsonb not null
);

create index if not exists idx_adl_deleted_at on public.application_deletion_log (deleted_at desc);
create index if not exists idx_adl_record_id on public.application_deletion_log (record_id);

alter table public.application_deletion_log enable row level security;

drop policy if exists "adl_select_admin" on public.application_deletion_log;
create policy "adl_select_admin" on public.application_deletion_log
  for select to authenticated
  using (public.is_admin());

-- 読むだけ（RLS で管理者だけ）。書き込みはトリガーだけなので authenticated には付けない
-- 🚨 今は新しい表に全部の権限が自動で付く（2026-10-30 まで）ので、書き込みははっきり外す
revoke all on public.application_deletion_log from anon, authenticated;
grant select on public.application_deletion_log to authenticated;
grant all on public.application_deletion_log to service_role;

create or replace function public.log_application_deletion()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text;
  v_applicant uuid;
  v_date date;
  v_snap jsonb := jsonb_build_object('record', to_jsonb(old));
  v_reason text := nullif(btrim(coalesce(current_setting('app.delete_reason', true), '')), '');
begin
  if tg_table_name = 'leave_requests' then
    v_kind := 'leave'; v_applicant := old.user_id; v_date := old.start_date;
    if v_reason is null and coalesce(old.reason, '') like '【有給奨励日】%' then
      v_reason := '有休奨励日の対象から外したため（自動）';
    end if;
  elsif tg_table_name = 'overtime_reports' then
    v_kind := 'overtime'; v_applicant := old.applicant_id; v_date := old.work_date;
    v_snap := v_snap || jsonb_build_object('segments', coalesce((
      select jsonb_agg(to_jsonb(s) order by s.phase, s.seg_no) from overtime_report_segments s where s.report_id = old.id), '[]'::jsonb));
    if v_reason is null and old.source_leave_request_id is not null then
      v_reason := '休暇の削除に合わせて（自動）';
    end if;
  elsif tg_table_name = 'shift_reports' then
    v_kind := 'shift'; v_applicant := old.applicant_id; v_date := old.work_date;
  else
    v_kind := 'expense'; v_applicant := old.user_id; v_date := null;
  end if;

  insert into public.application_deletion_log (kind, record_id, applicant_id, target_date, status, deleted_by, reason, snapshot)
  values (v_kind, old.id, v_applicant, v_date, old.status, auth.uid(), v_reason, v_snap);
  return old;
end;
$$;

revoke execute on function public.log_application_deletion() from public;
revoke execute on function public.log_application_deletion() from anon;
revoke execute on function public.log_application_deletion() from authenticated;

drop trigger if exists trg_log_application_deletion on public.leave_requests;
create trigger trg_log_application_deletion before delete on public.leave_requests
  for each row execute function public.log_application_deletion();
drop trigger if exists trg_log_application_deletion on public.overtime_reports;
create trigger trg_log_application_deletion before delete on public.overtime_reports
  for each row execute function public.log_application_deletion();
drop trigger if exists trg_log_application_deletion on public.shift_reports;
create trigger trg_log_application_deletion before delete on public.shift_reports
  for each row execute function public.log_application_deletion();
drop trigger if exists trg_log_application_deletion on public.expenses;
create trigger trg_log_application_deletion before delete on public.expenses
  for each row execute function public.log_application_deletion();

-- 画面から消すときの入口（理由は必須・1〜200字）。消した件数を返す（RLS で消せなかった分は数に入らない）
-- 🚨 SECURITY INVOKER：消せるかどうかは各表の RLS のまま。この関数で権限は広がらない
create or replace function public.delete_applications(p_kind text, p_ids uuid[], p_reason text)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_reason text := btrim(coalesce(p_reason, ''));
  v_n integer;
begin
  if v_reason = '' then raise exception '削除の理由を入力してください' using errcode = '22023'; end if;
  if length(v_reason) > 200 then raise exception '削除の理由は200字までです' using errcode = '22023'; end if;
  if p_ids is null or cardinality(p_ids) = 0 then return 0; end if;
  perform set_config('app.delete_reason', v_reason, true);   -- この取引の中だけ（トリガーが読む）

  if p_kind = 'leave' then
    delete from leave_requests where id = any(p_ids);
  elsif p_kind = 'overtime' then
    delete from overtime_reports where id = any(p_ids);
  elsif p_kind = 'shift' then
    delete from shift_reports where id = any(p_ids);
  elsif p_kind = 'expense' then
    delete from expenses where id = any(p_ids);
  else
    raise exception '種類が正しくありません' using errcode = '22023';
  end if;
  get diagnostics v_n = row_count;
  perform set_config('app.delete_reason', '', true);
  return v_n;
end;
$$;

revoke execute on function public.delete_applications(text, uuid[], text) from public;
revoke execute on function public.delete_applications(text, uuid[], text) from anon;
grant execute on function public.delete_applications(text, uuid[], text) to authenticated;

-- 掃除：3年より古い記録（毎月2日 4:10 JST＝UTC の1日 19:10）
select cron.unschedule('purge-application-deletion-log') where exists (select 1 from cron.job where jobname = 'purge-application-deletion-log');
select cron.schedule('purge-application-deletion-log', '10 19 1 * *',
  $$delete from public.application_deletion_log where deleted_at < now() - interval '3 years'$$);
