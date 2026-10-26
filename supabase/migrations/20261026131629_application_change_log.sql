-- 経理向け「受理済みの変更」（2026-10-26 ユーザー確定・計画 docs/計画-経理向け変わった申請の一覧.md）
-- 残業・休暇・勤務変更・交通費・勤怠カレンダーの予定が変わるたびに1行残す。
-- 読むのは管理者だけ（admin_change_log）。書くのはトリガーだけ。
-- 🚨 記録に失敗しても申請の保存は止めない（例外は受けて「記録の失敗」の行を残す）
-- 🚨 大きな直しの SQL を流すときは、その取引で set_config('app.change_log_off','on',true) にすると記録しない

-- ─────────────────────────────────────────────
-- 1. した人を決める（ログインした人／Edge Function が付けた見出し／自動）
-- ─────────────────────────────────────────────
-- Edge Function はサーバーの鍵で書くので auth.uid() が空になる。
-- そのときだけ、要求の見出し x-actor-id を信じる（サーバーの鍵のときだけ。画面からの見出しは読まない）
create or replace function public.change_log_actor()
returns uuid
language plpgsql
stable
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_role text;
  v_hdr text;
begin
  if v_uid is not null then
    return v_uid;
  end if;
  begin
    v_role := nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role';
  exception when others then
    v_role := null;
  end;
  if v_role = 'service_role' then
    begin
      v_hdr := nullif(current_setting('request.headers', true), '')::json ->> 'x-actor-id';
      if v_hdr ~ '^[0-9a-fA-F-]{36}$' then
        return v_hdr::uuid;
      end if;
    exception when others then
      return null;
    end;
  end if;
  return null;
end;
$$;

revoke execute on function public.change_log_actor() from public;
revoke execute on function public.change_log_actor() from anon;
revoke execute on function public.change_log_actor() from authenticated;

-- ─────────────────────────────────────────────
-- 2. 表
-- ─────────────────────────────────────────────
create table if not exists public.application_change_log (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  kind text not null check (kind in ('overtime','leave','shift','expense','attendance')),
  record_id uuid not null,              -- 外部キーは張らない（申請を消しても記録は残す）
  applicant_id uuid,
  op text not null check (op in ('insert','update','delete','error')),
  event text not null,                  -- created / accepted / pre_accepted / reported / step / returned / cancelled / edited / status / deleted / error
  old_status text,
  new_status text,
  accepted_before boolean not null default false,
  accepted_after boolean not null default false,
  target_dates date[] not null default '{}',
  periods date[] not null default '{}', -- 前と後の全部の日の給与期間（16日始まり）
  before jsonb,
  after jsonb,
  actor_id uuid,
  actor_via text not null default 'system' check (actor_via in ('user','edge','system')),
  reason text,
  error text
);

create index if not exists application_change_log_periods_idx on public.application_change_log using gin (periods);
create index if not exists application_change_log_at_idx on public.application_change_log (at desc);
create index if not exists application_change_log_record_idx on public.application_change_log (record_id);

alter table public.application_change_log enable row level security;
revoke all on public.application_change_log from anon;
revoke all on public.application_change_log from authenticated;
grant all on public.application_change_log to service_role;

-- 経理が「ここまで確認した」の印（Excel・CSV を出したとき／［確認済みにする］を押したとき）
create table if not exists public.payroll_check_marks (
  id uuid primary key default gen_random_uuid(),
  period_start date not null,
  kind text not null check (kind in ('excel_overtime','excel_shift','list_overtime','list_shift','expense','change_log_excel','manual')),
  upto timestamptz not null,            -- この時刻までの変更を確認した（押した時刻ではなく、画面に出ていたいちばん新しい行の時刻）
  row_count integer,
  marked_at timestamptz not null default now(),
  marked_by uuid
);

create index if not exists payroll_check_marks_period_idx on public.payroll_check_marks (period_start, marked_at desc);

alter table public.payroll_check_marks enable row level security;
revoke all on public.payroll_check_marks from anon;
revoke all on public.payroll_check_marks from authenticated;
grant all on public.payroll_check_marks to service_role;

-- ─────────────────────────────────────────────
-- 3. 記録するトリガー
-- ─────────────────────────────────────────────
create or replace function public.change_log_pick(j jsonb, keys text[])
returns jsonb
language sql
immutable
as $$
  select coalesce(jsonb_object_agg(k, j -> k), '{}'::jsonb) from unnest(keys) k where j ? k;
$$;

revoke execute on function public.change_log_pick(jsonb, text[]) from public;
revoke execute on function public.change_log_pick(jsonb, text[]) from anon;
revoke execute on function public.change_log_pick(jsonb, text[]) from authenticated;

-- 休暇・交通費の日付（読めない値は飛ばす）
create or replace function public.change_log_dates(p_kind text, j jsonb)
returns date[]
language plpgsql
immutable
as $$
declare
  v date[] := '{}';
  v_txt text;
  v_item jsonb;
begin
  if j is null then
    return v;
  end if;
  if p_kind in ('overtime','shift') then
    if j->>'work_date' is not null then v := v || (j->>'work_date')::date; end if;
    if p_kind = 'overtime' and j->>'furikae_origin_date' is not null then v := v || (j->>'furikae_origin_date')::date; end if;
  elsif p_kind = 'attendance' then
    if j->>'date' is not null then v := v || (j->>'date')::date; end if;
  elsif p_kind = 'leave' then
    v_txt := j->>'leave_dates';
    if v_txt is not null and v_txt like '[%' then
      begin
        select coalesce(array_agg(x::date), '{}') into v
        from jsonb_array_elements_text(v_txt::jsonb) x where x ~ '^\d{4}-\d{2}-\d{2}$';
      exception when others then
        v := '{}';
      end;
    end if;
    if cardinality(v) = 0 and j->>'start_date' is not null then
      select coalesce(array_agg(d::date), '{}') into v
      from (select generate_series((j->>'start_date')::date, coalesce((j->>'end_date')::date, (j->>'start_date')::date), interval '1 day') d limit 400) g;
    end if;
  elsif p_kind = 'expense' then
    if jsonb_typeof(j->'expenses_data') = 'array' then
      for v_item in select * from jsonb_array_elements(j->'expenses_data') loop
        if coalesce(v_item->>'start_date','') ~ '^\d{4}-\d{2}-\d{2}$' then v := v || (v_item->>'start_date')::date; end if;
        if coalesce(v_item->>'end_date','') ~ '^\d{4}-\d{2}-\d{2}$' then v := v || (v_item->>'end_date')::date; end if;
      end loop;
    end if;
  end if;
  return v;
end;
$$;

revoke execute on function public.change_log_dates(text, jsonb) from public;
revoke execute on function public.change_log_dates(text, jsonb) from anon;
revoke execute on function public.change_log_dates(text, jsonb) from authenticated;

create or replace function public.log_application_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind text;
  v_keys text[];
  v_old jsonb := case when tg_op in ('UPDATE','DELETE') then to_jsonb(old) else null end;
  v_new jsonb := case when tg_op in ('INSERT','UPDATE') then to_jsonb(new) else null end;
  v_b jsonb; v_a jsonb;
  v_os text; v_ns text;
  v_acc_b boolean := false; v_acc_a boolean := false;
  v_event text;
  v_dates date[];
  v_actor uuid;
  v_via text := 'system';
  v_applicant uuid;
  v_id uuid;
begin
  if coalesce(current_setting('app.change_log_off', true), '') = 'on' then
    return null;
  end if;

  begin
    if tg_table_name = 'overtime_reports' then
      v_kind := 'overtime';
      -- 休暇から自動でできる時間外調整休の行は記録しない（休暇の側で残る）
      if coalesce(v_new->>'entry_type', v_old->>'entry_type') = 'leave_auto' then
        return null;
      end if;
      v_keys := array['status','work_date','application_types','labor_minutes','diff_minutes','break_minutes','location','is_post_hoc',
                      'furikae_origin_date','furikae_origin_start','furikae_origin_end','furikae_origin_labor_minutes'];
      v_applicant := coalesce(v_new->>'applicant_id', v_old->>'applicant_id')::uuid;
      v_acc_b := coalesce(v_old->>'status','') = 'confirmed';
      v_acc_a := coalesce(v_new->>'status','') = 'confirmed';
    elsif tg_table_name = 'leave_requests' then
      v_kind := 'leave';
      v_keys := array['status','leave_type','leave_type_other','start_date','end_date','leave_dates','chosei_sub_type','user_id'];
      v_applicant := coalesce(v_new->>'user_id', v_old->>'user_id')::uuid;
      v_acc_b := coalesce(v_old->>'status','') = 'approved';
      v_acc_a := coalesce(v_new->>'status','') = 'approved';
    elsif tg_table_name = 'shift_reports' then
      v_kind := 'shift';
      v_keys := array['status','work_date','application_type','application_types','original_start','original_end','actual_start','actual_end',
                      'break_minutes','labor_minutes','original_segments','actual_segments','actual_location'];
      v_applicant := coalesce(v_new->>'applicant_id', v_old->>'applicant_id')::uuid;
      v_acc_b := coalesce(v_old->>'status','') = 'confirmed';
      v_acc_a := coalesce(v_new->>'status','') = 'confirmed';
    elsif tg_table_name = 'expenses' then
      v_kind := 'expense';
      v_keys := array['status','expenses_data'];
      v_applicant := coalesce(v_new->>'user_id', v_old->>'user_id')::uuid;
      v_acc_b := coalesce(v_old->>'status','') = 'approved';
      v_acc_a := coalesce(v_new->>'status','') = 'approved';
    else
      v_kind := 'attendance';
      v_keys := array['user_id','date','type','actual_time','location','work_segments'];
      v_applicant := coalesce(v_new->>'user_id', v_old->>'user_id')::uuid;
      -- 勤怠カレンダーの予定は受理が無い＝入れた時点で確定
      v_acc_b := v_old is not null;
      v_acc_a := v_new is not null;
    end if;

    v_b := case when v_old is null then null else change_log_pick(v_old, v_keys) end;
    v_a := case when v_new is null then null else change_log_pick(v_new, v_keys) end;
    if tg_op = 'UPDATE' and v_b = v_a then
      return null;
    end if;

    v_os := v_old->>'status';
    v_ns := v_new->>'status';

    if tg_op = 'INSERT' then
      v_event := 'created';
    elsif tg_op = 'DELETE' then
      v_event := 'deleted';
    elsif v_os is distinct from v_ns then
      v_event := case
        when v_acc_a then 'accepted'
        when v_ns = 'cancelled' then 'cancelled'
        when v_ns in ('rejected','returned') then 'returned'
        when v_ns = 'request_confirmed' then 'pre_accepted'
        when v_ns = 'reported' then 'reported'
        when v_ns in ('manager_approved','admin_approved') then 'step'
        else 'status' end;
    else
      v_event := 'edited';
    end if;

    select coalesce(array_agg(distinct d order by d), '{}') into v_dates
    from unnest(change_log_dates(v_kind, v_old) || change_log_dates(v_kind, v_new)) d;

    v_actor := change_log_actor();
    if auth.uid() is not null then
      v_via := 'user';
    elsif v_actor is not null then
      v_via := 'edge';
    end if;

    insert into application_change_log
      (kind, record_id, applicant_id, op, event, old_status, new_status, accepted_before, accepted_after,
       target_dates, periods, before, after, actor_id, actor_via, reason)
    values
      (v_kind, coalesce(v_new->>'id', v_old->>'id')::uuid, v_applicant, lower(tg_op), v_event, v_os, v_ns, v_acc_b, v_acc_a,
       v_dates,
       coalesce((select array_agg(distinct calc_pay_period_start(d) order by calc_pay_period_start(d)) from unnest(v_dates) d), '{}'),
       v_b, v_a, v_actor, v_via,
       case when tg_op = 'DELETE' then nullif(btrim(coalesce(current_setting('app.delete_reason', true), '')), '') end);
  exception when others then
    begin
      v_id := coalesce(v_new->>'id', v_old->>'id')::uuid;
      insert into application_change_log (kind, record_id, applicant_id, op, event, error, actor_id)
      values (coalesce(v_kind, 'overtime'), coalesce(v_id, '00000000-0000-0000-0000-000000000000'::uuid), v_applicant,
              'error', 'error', left(sqlstate || ' ' || sqlerrm, 500), auth.uid());
    exception when others then
      raise warning '[log_application_change] 記録の失敗: %', sqlerrm;
    end;
  end;
  return null;
end;
$$;

revoke execute on function public.log_application_change() from public;
revoke execute on function public.log_application_change() from anon;
revoke execute on function public.log_application_change() from authenticated;

-- 見る列が変わったときだけ動く（cron が毎日書くお知らせの時刻などでは動かない）
drop trigger if exists trg_zz_change_log_ins on public.overtime_reports;
drop trigger if exists trg_zz_change_log_upd on public.overtime_reports;
drop trigger if exists trg_zz_change_log_del on public.overtime_reports;
create trigger trg_zz_change_log_ins after insert on public.overtime_reports for each row execute function public.log_application_change();
create trigger trg_zz_change_log_del after delete on public.overtime_reports for each row execute function public.log_application_change();
create trigger trg_zz_change_log_upd after update on public.overtime_reports for each row
  when (old.status is distinct from new.status or old.work_date is distinct from new.work_date
     or old.application_types is distinct from new.application_types or old.labor_minutes is distinct from new.labor_minutes
     or old.diff_minutes is distinct from new.diff_minutes or old.break_minutes is distinct from new.break_minutes
     or old.location is distinct from new.location or old.is_post_hoc is distinct from new.is_post_hoc
     or old.furikae_origin_date is distinct from new.furikae_origin_date or old.furikae_origin_start is distinct from new.furikae_origin_start
     or old.furikae_origin_end is distinct from new.furikae_origin_end or old.furikae_origin_labor_minutes is distinct from new.furikae_origin_labor_minutes)
  execute function public.log_application_change();

drop trigger if exists trg_zz_change_log_ins on public.leave_requests;
drop trigger if exists trg_zz_change_log_upd on public.leave_requests;
drop trigger if exists trg_zz_change_log_del on public.leave_requests;
create trigger trg_zz_change_log_ins after insert on public.leave_requests for each row execute function public.log_application_change();
create trigger trg_zz_change_log_del after delete on public.leave_requests for each row execute function public.log_application_change();
create trigger trg_zz_change_log_upd after update on public.leave_requests for each row
  when (old.status is distinct from new.status or old.leave_type is distinct from new.leave_type
     or old.leave_type_other is distinct from new.leave_type_other or old.start_date is distinct from new.start_date
     or old.end_date is distinct from new.end_date or old.leave_dates is distinct from new.leave_dates
     or old.chosei_sub_type is distinct from new.chosei_sub_type or old.user_id is distinct from new.user_id)
  execute function public.log_application_change();

drop trigger if exists trg_zz_change_log_ins on public.shift_reports;
drop trigger if exists trg_zz_change_log_upd on public.shift_reports;
drop trigger if exists trg_zz_change_log_del on public.shift_reports;
create trigger trg_zz_change_log_ins after insert on public.shift_reports for each row execute function public.log_application_change();
create trigger trg_zz_change_log_del after delete on public.shift_reports for each row execute function public.log_application_change();
create trigger trg_zz_change_log_upd after update on public.shift_reports for each row
  when (old.status is distinct from new.status or old.work_date is distinct from new.work_date
     or old.application_type is distinct from new.application_type or old.application_types is distinct from new.application_types
     or old.original_start is distinct from new.original_start or old.original_end is distinct from new.original_end
     or old.actual_start is distinct from new.actual_start or old.actual_end is distinct from new.actual_end
     or old.break_minutes is distinct from new.break_minutes or old.labor_minutes is distinct from new.labor_minutes
     or old.original_segments is distinct from new.original_segments or old.actual_segments is distinct from new.actual_segments
     or old.actual_location is distinct from new.actual_location)
  execute function public.log_application_change();

drop trigger if exists trg_zz_change_log_ins on public.expenses;
drop trigger if exists trg_zz_change_log_upd on public.expenses;
drop trigger if exists trg_zz_change_log_del on public.expenses;
create trigger trg_zz_change_log_ins after insert on public.expenses for each row execute function public.log_application_change();
create trigger trg_zz_change_log_del after delete on public.expenses for each row execute function public.log_application_change();
create trigger trg_zz_change_log_upd after update on public.expenses for each row
  when (old.status is distinct from new.status or old.expenses_data is distinct from new.expenses_data)
  execute function public.log_application_change();

drop trigger if exists trg_zz_change_log_ins on public.attendance_exceptions;
drop trigger if exists trg_zz_change_log_upd on public.attendance_exceptions;
drop trigger if exists trg_zz_change_log_del on public.attendance_exceptions;
create trigger trg_zz_change_log_ins after insert on public.attendance_exceptions for each row execute function public.log_application_change();
create trigger trg_zz_change_log_del after delete on public.attendance_exceptions for each row execute function public.log_application_change();
create trigger trg_zz_change_log_upd after update on public.attendance_exceptions for each row
  when (old.user_id is distinct from new.user_id or old.date is distinct from new.date or old.type is distinct from new.type
     or old.actual_time is distinct from new.actual_time or old.location is distinct from new.location
     or old.work_segments is distinct from new.work_segments)
  execute function public.log_application_change();

-- ─────────────────────────────────────────────
-- 4. 削除の記録も「した人」を同じ決め方に（本番の実定義から・auth.uid() の1か所だけ差し替え）
-- ─────────────────────────────────────────────
create or replace function public.log_application_deletion()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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
  values (v_kind, old.id, v_applicant, v_date, old.status, public.change_log_actor(), v_reason, v_snap);
  return old;
end;
$function$;

-- ─────────────────────────────────────────────
-- 5. 確認の印（管理者だけ）
-- ─────────────────────────────────────────────
create or replace function public.payroll_check_mark(p_period date, p_kind text, p_upto timestamptz default null, p_count integer default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row payroll_check_marks;
begin
  if not is_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_period is null or extract(day from p_period) <> 16 then
    raise exception 'period must start on the 16th' using errcode = '22023';
  end if;
  insert into payroll_check_marks (period_start, kind, upto, row_count, marked_by)
  values (p_period, p_kind, coalesce(p_upto, now()), p_count, auth.uid())
  returning * into v_row;
  return to_jsonb(v_row);
end;
$$;

revoke execute on function public.payroll_check_mark(date, text, timestamptz, integer) from public;
revoke execute on function public.payroll_check_mark(date, text, timestamptz, integer) from anon;
grant execute on function public.payroll_check_mark(date, text, timestamptz, integer) to authenticated;

-- 1つ前に戻す（いちばん新しい印を消す）
create or replace function public.payroll_check_mark_undo(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period date;
  v_latest uuid;
begin
  if not is_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select period_start into v_period from payroll_check_marks where id = p_id;
  if v_period is null then
    return false;
  end if;
  select id into v_latest from payroll_check_marks where period_start = v_period order by marked_at desc limit 1;
  if v_latest is distinct from p_id then
    raise exception 'only the latest mark can be undone' using errcode = '22023';
  end if;
  delete from payroll_check_marks where id = p_id;
  return true;
end;
$$;

revoke execute on function public.payroll_check_mark_undo(uuid) from public;
revoke execute on function public.payroll_check_mark_undo(uuid) from anon;
grant execute on function public.payroll_check_mark_undo(uuid) to authenticated;

-- ─────────────────────────────────────────────
-- 6. 読む（管理者だけ・1回でまとめて返す＝1000件で黙って切れない）
-- ─────────────────────────────────────────────
-- rows：この期の日に当たる変更／closed：この期が始まったあとに、締め（支給月17日）を過ぎた前の期へ当たった変更
create or replace function public.admin_change_log(p_period date)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_rows jsonb;
  v_closed jsonb;
  v_marks jsonb;
  v_since timestamptz;
  v_n integer;
begin
  if not is_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;

  select min(at) into v_since from application_change_log;

  select count(*) into v_n from application_change_log where p_period = any(periods) and op <> 'error';

  with base as (
    select l.*, pa.name as applicant_name, pa.employee_no, pc.name as actor_name, rc.name as actor_role, rc.is_fixed as actor_is_admin_role
    from application_change_log l
    left join profiles pa on pa.id = l.applicant_id
    left join profiles pc on pc.id = l.actor_id
    left join roles rc on rc.id = pc.role_id
  )
  select
    coalesce((select jsonb_agg(to_jsonb(b) order by b.at) from (select * from base where p_period = any(periods) and op <> 'error' order by at limit 5000) b), '[]'::jsonb),
    coalesce((select jsonb_agg(to_jsonb(b) order by b.at) from (
       select * from base
       where op <> 'error' and at >= (p_period::timestamp at time zone 'Asia/Tokyo')
         and exists (select 1 from unnest(periods) q
                     where q < p_period
                       and at >= (make_date(extract(year from (q + interval '1 month'))::int, extract(month from (q + interval '1 month'))::int, 17)::timestamp at time zone 'Asia/Tokyo'))
       order by at limit 1000) b), '[]'::jsonb)
  into v_rows, v_closed;

  select coalesce(jsonb_agg(to_jsonb(m) order by m.marked_at desc), '[]'::jsonb) into v_marks
  from (select m.*, p.name as marked_by_name from payroll_check_marks m left join profiles p on p.id = m.marked_by
        where m.period_start = p_period order by m.marked_at desc limit 10) m;

  return jsonb_build_object('since', v_since, 'count', v_n, 'truncated', v_n > 5000,
                            'rows', v_rows, 'closed', v_closed, 'marks', v_marks,
                            'errors', (select count(*) from application_change_log where op = 'error' and at > now() - interval '30 days'));
end;
$$;

revoke execute on function public.admin_change_log(date) from public;
revoke execute on function public.admin_change_log(date) from anon;
grant execute on function public.admin_change_log(date) to authenticated;

-- ─────────────────────────────────────────────
-- 7. 掃除（毎月2日 4:30 JST・3年より古い行）
-- ─────────────────────────────────────────────
do $$
begin
  if exists (select 1 from cron.job where jobname = 'purge-application-change-log') then
    perform cron.unschedule('purge-application-change-log');
  end if;
  perform cron.schedule('purge-application-change-log', '30 19 1 * *',
    $c$delete from public.application_change_log where at < now() - interval '3 years';
       delete from public.payroll_check_marks where marked_at < now() - interval '3 years';$c$);
end $$;
