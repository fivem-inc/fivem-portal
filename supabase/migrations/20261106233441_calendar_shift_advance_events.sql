-- ============================================================
-- 2026-11-06  勤務変更の事前申請（パートの方）を勤怠カレンダー・Google カレンダーに出す（ユーザー確定）
-- ============================================================
-- ・出すのは上長が受理した事前申請だけ（受理待ちは出さない）。残業の事前申請と同じ考え方
--     request_confirmed（受理済み・報告まち）／confirmed（確定）… 申請の中身（actual_*）
--     pending・resubmitted・returned（［時間が違いました］で報告して確認まち・差し戻し）… 受理のときの写し（planned）
--     requested（受理まち・受理のやり直し）・cancelled・行が無い（取消・［変更はありませんでした］）… 出さない
-- ・「何を出すか」はこの関数1か所。勤怠カレンダー（CalendarPage の fetchOvertimes）と gcal-sync（source_type 'shift_report'）の両方が使う
-- ・理由（reason）は返さない（calendar_overtime_events と同じ方針）
-- ・見られるのは勤怠カレンダーの権限（leave_calendar）の方と service（gcal-sync）だけ。anon 不可

begin;

create or replace function public.calendar_shift_advance_events(p_from date, p_to date, p_id uuid default null)
returns table(id uuid, applicant_id uuid, name text, work_date date, application_types text[], location text,
              start_min integer, end_min integer, status text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  with src as (
    select r.id, r.applicant_id, r.work_date, r.status,
           case when r.status in ('pending', 'resubmitted', 'returned') and r.planned is not null
                then r.planned
                else jsonb_build_object('application_type', r.application_type, 'application_types', to_jsonb(r.application_types),
                       'actual_start', r.actual_start, 'actual_end', r.actual_end, 'actual_segments', r.actual_segments,
                       'actual_location', r.actual_location) end as v
      from shift_reports r
     where (has_feature_permission('leave_calendar') or auth.uid() is null)
       and r.advance
       and r.request_confirmed_at is not null
       and r.status in ('request_confirmed', 'confirmed', 'pending', 'resubmitted', 'returned')
       and (p_id is null or r.id = p_id)
       and (p_id is not null or r.work_date between p_from and p_to)
  )
  select s.id, s.applicant_id, p.name, s.work_date,
         coalesce((select array_agg(t) from jsonb_array_elements_text(case when jsonb_typeof(s.v->'application_types') = 'array' then s.v->'application_types' else '[]'::jsonb end) t),
                  array[s.v->>'application_type']) as application_types,
         coalesce(nullif(s.v->>'actual_location', ''),
                  (select e->>'location' from jsonb_array_elements(case when jsonb_typeof(s.v->'actual_segments') = 'array' then s.v->'actual_segments' else '[]'::jsonb end) e
                    where coalesce(e->>'location', '') <> '' limit 1)) as location,
         coalesce((select min(extract(hour from (e->>'start')::time) * 60 + extract(minute from (e->>'start')::time))::int
                     from jsonb_array_elements(case when jsonb_typeof(s.v->'actual_segments') = 'array' then s.v->'actual_segments' else '[]'::jsonb end) e
                    where coalesce(e->>'start', '') <> ''),
                  (extract(hour from (s.v->>'actual_start')::time) * 60 + extract(minute from (s.v->>'actual_start')::time))::int) as start_min,
         coalesce((select max(extract(hour from (e->>'end')::time) * 60 + extract(minute from (e->>'end')::time))::int
                     from jsonb_array_elements(case when jsonb_typeof(s.v->'actual_segments') = 'array' then s.v->'actual_segments' else '[]'::jsonb end) e
                    where coalesce(e->>'end', '') <> ''),
                  (extract(hour from (s.v->>'actual_end')::time) * 60 + extract(minute from (s.v->>'actual_end')::time))::int) as end_min,
         s.status
    from src s
    join profiles p on p.id = s.applicant_id;
$function$;

revoke execute on function public.calendar_shift_advance_events(date, date, uuid) from public;
revoke execute on function public.calendar_shift_advance_events(date, date, uuid) from anon;
grant execute on function public.calendar_shift_advance_events(date, date, uuid) to authenticated, service_role;

-- Google カレンダーへの反映は、画面の各ボタンではなくここ1か所で頼む（受理・報告・確認・差し戻し・取消・削除・受理のやり直しのどれでも）。
-- gcal-sync（source_type 'shift_report'）は DB の今の状態から「あるべき姿」にそろえる＝何度呼んでも同じ。
-- 🚨 pg_net は取引が確定したあとに送る（取り消した取引の分は送られない）。失敗しても保存は止めない
create or replace function public.shift_report_gcal_request()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  begin
    if tg_op = 'DELETE' then
      if old.advance and old.request_confirmed_at is not null then
        perform cron_call_edge('gcal-sync', jsonb_build_object('action', 'sync', 'source_type', 'shift_report', 'source_id', old.id));
      end if;
      return old;
    end if;
    if new.advance
       and (new.request_confirmed_at is not null or old.request_confirmed_at is not null)
       and (new.status is distinct from old.status
            or new.work_date is distinct from old.work_date
            or new.actual_start is distinct from old.actual_start
            or new.actual_end is distinct from old.actual_end
            or new.actual_location is distinct from old.actual_location
            or new.actual_segments is distinct from old.actual_segments
            or new.application_types is distinct from old.application_types) then
      perform cron_call_edge('gcal-sync', jsonb_build_object('action', 'sync', 'source_type', 'shift_report', 'source_id', new.id));
    end if;
  exception when others then
    raise warning '[shift_report_gcal_request] %', sqlerrm;
  end;
  return new;
end;
$function$;
revoke execute on function public.shift_report_gcal_request() from public;
revoke execute on function public.shift_report_gcal_request() from anon;
revoke execute on function public.shift_report_gcal_request() from authenticated;

drop trigger if exists trg_zz_shift_report_gcal on public.shift_reports;
create trigger trg_zz_shift_report_gcal
  after update or delete on public.shift_reports
  for each row execute function public.shift_report_gcal_request();

commit;
-- 戻すとき：drop trigger trg_zz_shift_report_gcal on public.shift_reports; drop function public.shift_report_gcal_request(); drop function public.calendar_shift_advance_events(date, date, uuid);
