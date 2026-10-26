-- 「受理済みの変更」の記録の直し（2026-10-26・別のエージェントのレビューの指摘を本番で裏取りしてから）
-- 1. 残業の時刻（overtime_report_segments）が変わっても記録されなかった → 時間帯の表にも記録を付ける（event 'time_changed'・前後の時間帯）
-- 2. 見ていなかった列を足す（勤務変更の中抜けの時刻・元の場所／勤怠カレンダーの休憩・元の場所／残業の振替元の場所・休憩・申請者・入力の種類）
-- 3. 差し戻しのあとの再提出を 'resubmitted' に分ける（残業 requested・勤務変更 resubmitted／pending・休暇 pending）
-- 4. 同じ取引の行が同じ時刻にならないよう、時刻を clock_timestamp() に
-- 5. admin_change_log：先に絞ってから名前をつなぐ（呼ぶたびに全件を読まない）・GIN 索引が効く書き方・上限は新しい側を残す・期間は16日始まりだけ

alter table public.application_change_log alter column at set default clock_timestamp();

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
                      'furikae_origin_date','furikae_origin_start','furikae_origin_end','furikae_origin_labor_minutes',
                      'furikae_origin_location','furikae_origin_break_minutes','applicant_id','entry_type'];
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
                      'break_minutes','labor_minutes','original_segments','actual_segments','actual_location','original_location',
                      'original_outing_start','original_outing_end','actual_outing_start','actual_outing_end'];
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
      v_keys := array['user_id','date','type','actual_time','location','work_segments','planned_break_minutes','original_location'];
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
        when v_ns in ('requested','resubmitted','pending') and v_os in ('returned','rejected') then 'resubmitted'
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

drop trigger if exists trg_zz_change_log_upd on public.overtime_reports;
create trigger trg_zz_change_log_upd after update on public.overtime_reports for each row
  when (old.status is distinct from new.status or old.work_date is distinct from new.work_date
     or old.application_types is distinct from new.application_types or old.labor_minutes is distinct from new.labor_minutes
     or old.diff_minutes is distinct from new.diff_minutes or old.break_minutes is distinct from new.break_minutes
     or old.location is distinct from new.location or old.is_post_hoc is distinct from new.is_post_hoc
     or old.furikae_origin_date is distinct from new.furikae_origin_date or old.furikae_origin_start is distinct from new.furikae_origin_start
     or old.furikae_origin_end is distinct from new.furikae_origin_end or old.furikae_origin_labor_minutes is distinct from new.furikae_origin_labor_minutes
     or old.furikae_origin_location is distinct from new.furikae_origin_location or old.furikae_origin_break_minutes is distinct from new.furikae_origin_break_minutes
     or old.applicant_id is distinct from new.applicant_id or old.entry_type is distinct from new.entry_type)
  execute function public.log_application_change();

drop trigger if exists trg_zz_change_log_upd on public.shift_reports;
create trigger trg_zz_change_log_upd after update on public.shift_reports for each row
  when (old.status is distinct from new.status or old.work_date is distinct from new.work_date
     or old.application_type is distinct from new.application_type or old.application_types is distinct from new.application_types
     or old.original_start is distinct from new.original_start or old.original_end is distinct from new.original_end
     or old.actual_start is distinct from new.actual_start or old.actual_end is distinct from new.actual_end
     or old.break_minutes is distinct from new.break_minutes or old.labor_minutes is distinct from new.labor_minutes
     or old.original_segments is distinct from new.original_segments or old.actual_segments is distinct from new.actual_segments
     or old.actual_location is distinct from new.actual_location or old.original_location is distinct from new.original_location
     or old.original_outing_start is distinct from new.original_outing_start or old.original_outing_end is distinct from new.original_outing_end
     or old.actual_outing_start is distinct from new.actual_outing_start or old.actual_outing_end is distinct from new.actual_outing_end)
  execute function public.log_application_change();

drop trigger if exists trg_zz_change_log_upd on public.attendance_exceptions;
create trigger trg_zz_change_log_upd after update on public.attendance_exceptions for each row
  when (old.user_id is distinct from new.user_id or old.date is distinct from new.date or old.type is distinct from new.type
     or old.actual_time is distinct from new.actual_time or old.location is distinct from new.location
     or old.work_segments is distinct from new.work_segments or old.planned_break_minutes is distinct from new.planned_break_minutes
     or old.original_location is distinct from new.original_location)
  execute function public.log_application_change();

-- ─────────────────────────────────────────────
-- 残業の時間帯（overtime_report_segments）
-- ─────────────────────────────────────────────
-- 画面は「時間帯を消す」「入れる」を別々の要求で送るので、1回の文ごとに、その申請の前と後の時間帯を丸ごと残す。
-- 申請ごと消したとき（外部キーの連鎖）は申請の側で「削除」が残るので、ここでは何もしない
create or replace function public.log_overtime_segments_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_ids uuid[];
  v_rid uuid;
  v_after jsonb;
  v_before jsonb;
  v_dates date[];
  v_actor uuid;
  v_via text;
begin
  if coalesce(current_setting('app.change_log_off', true), '') = 'on' then
    return null;
  end if;

  begin
    if tg_op = 'INSERT' then
      select array_agg(distinct report_id) into v_ids from nt;
    elsif tg_op = 'DELETE' then
      select array_agg(distinct report_id) into v_ids from ot;
    else
      select array_agg(distinct report_id) into v_ids from (select report_id from ot union select report_id from nt) u;
    end if;
    if v_ids is null then
      return null;
    end if;

    v_actor := change_log_actor();
    v_via := case when auth.uid() is not null then 'user' when v_actor is not null then 'edge' else 'system' end;

    foreach v_rid in array v_ids loop
      select id, applicant_id, status, entry_type, work_date, furikae_origin_date into r from overtime_reports where id = v_rid;
      if not found or coalesce(r.entry_type, '') = 'leave_auto' then
        continue;
      end if;

      select coalesce(jsonb_agg(jsonb_build_object('phase', phase, 'seg_no', seg_no, 'start_min', start_min, 'end_min', end_min) order by phase, seg_no, start_min), '[]'::jsonb)
        into v_after from overtime_report_segments where report_id = v_rid;

      if tg_op = 'INSERT' then
        select coalesce(jsonb_agg(jsonb_build_object('phase', phase, 'seg_no', seg_no, 'start_min', start_min, 'end_min', end_min) order by phase, seg_no, start_min), '[]'::jsonb)
          into v_before from overtime_report_segments s where s.report_id = v_rid and not exists (select 1 from nt where nt.id = s.id);
      elsif tg_op = 'DELETE' then
        select coalesce(jsonb_agg(jsonb_build_object('phase', phase, 'seg_no', seg_no, 'start_min', start_min, 'end_min', end_min) order by phase, seg_no, start_min), '[]'::jsonb)
          into v_before from (select phase, seg_no, start_min, end_min from overtime_report_segments where report_id = v_rid
                              union all select phase, seg_no, start_min, end_min from ot where ot.report_id = v_rid) x;
      else
        select coalesce(jsonb_agg(jsonb_build_object('phase', phase, 'seg_no', seg_no, 'start_min', start_min, 'end_min', end_min) order by phase, seg_no, start_min), '[]'::jsonb)
          into v_before from (select phase, seg_no, start_min, end_min from overtime_report_segments s
                                where s.report_id = v_rid and not exists (select 1 from nt where nt.id = s.id)
                              union all select phase, seg_no, start_min, end_min from ot where ot.report_id = v_rid) x;
      end if;

      if v_before = v_after then
        continue;
      end if;

      v_dates := array_remove(array[r.work_date, r.furikae_origin_date], null);
      insert into application_change_log
        (kind, record_id, applicant_id, op, event, old_status, new_status, accepted_before, accepted_after,
         target_dates, periods, before, after, actor_id, actor_via)
      values
        ('overtime', v_rid, r.applicant_id, 'update', 'time_changed', r.status, r.status, r.status = 'confirmed', r.status = 'confirmed',
         v_dates,
         coalesce((select array_agg(distinct calc_pay_period_start(d) order by calc_pay_period_start(d)) from unnest(v_dates) d), '{}'),
         jsonb_build_object('segments', v_before), jsonb_build_object('segments', v_after), v_actor, v_via);
    end loop;
  exception when others then
    begin
      insert into application_change_log (kind, record_id, op, event, error, actor_id)
      values ('overtime', coalesce(v_rid, '00000000-0000-0000-0000-000000000000'::uuid), 'error', 'error', left(sqlstate || ' ' || sqlerrm, 500), auth.uid());
    exception when others then
      raise warning '[log_overtime_segments_change] 記録の失敗: %', sqlerrm;
    end;
  end;
  return null;
end;
$$;

revoke execute on function public.log_overtime_segments_change() from public;
revoke execute on function public.log_overtime_segments_change() from anon;
revoke execute on function public.log_overtime_segments_change() from authenticated;

drop trigger if exists trg_zz_change_log_seg_ins on public.overtime_report_segments;
drop trigger if exists trg_zz_change_log_seg_upd on public.overtime_report_segments;
drop trigger if exists trg_zz_change_log_seg_del on public.overtime_report_segments;
create trigger trg_zz_change_log_seg_ins after insert on public.overtime_report_segments
  referencing new table as nt for each statement execute function public.log_overtime_segments_change();
create trigger trg_zz_change_log_seg_upd after update on public.overtime_report_segments
  referencing old table as ot new table as nt for each statement execute function public.log_overtime_segments_change();
create trigger trg_zz_change_log_seg_del after delete on public.overtime_report_segments
  referencing old table as ot for each statement execute function public.log_overtime_segments_change();

-- ─────────────────────────────────────────────
-- 読む（先に絞ってから名前をつなぐ・新しい側を残す）
-- ─────────────────────────────────────────────
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
  v_start timestamptz;
begin
  if not is_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_period is null or extract(day from p_period) <> 16 then
    raise exception 'period must start on the 16th' using errcode = '22023';
  end if;
  v_start := p_period::timestamp at time zone 'Asia/Tokyo';

  select min(at) into v_since from application_change_log;
  select count(*) into v_n from application_change_log where periods @> array[p_period] and op <> 'error';

  select coalesce(jsonb_agg(to_jsonb(b) order by b.at, b.id), '[]'::jsonb) into v_rows
  from (
    select l.*, pa.name as applicant_name, pa.employee_no, pc.name as actor_name, rc.name as actor_role, rc.is_fixed as actor_is_admin_role
    from (select * from application_change_log
          where periods @> array[p_period] and op <> 'error'
          order by at desc, id desc limit 5000) l
    left join profiles pa on pa.id = l.applicant_id
    left join profiles pc on pc.id = l.actor_id
    left join roles rc on rc.id = pc.role_id
  ) b;

  select coalesce(jsonb_agg(to_jsonb(b) order by b.at, b.id), '[]'::jsonb) into v_closed
  from (
    select l.*, pa.name as applicant_name, pa.employee_no, pc.name as actor_name, rc.name as actor_role, rc.is_fixed as actor_is_admin_role
    from (select * from application_change_log c
          where c.op <> 'error' and c.at >= v_start
            and exists (select 1 from unnest(c.periods) q
                        where q < p_period
                          and c.at >= (make_date(extract(year from (q + interval '1 month'))::int, extract(month from (q + interval '1 month'))::int, 17)::timestamp at time zone 'Asia/Tokyo'))
          order by c.at desc, c.id desc limit 1000) l
    left join profiles pa on pa.id = l.applicant_id
    left join profiles pc on pc.id = l.actor_id
    left join roles rc on rc.id = pc.role_id
  ) b;

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
