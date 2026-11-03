-- 毎朝の自動の点検（2026-11-03 ユーザー確定：おかしいときだけ知らせる・ベルだけ・管理者と社長）
--
-- ・毎朝 9:05（JST）に前の日を点検し、確認が要ることがあれば、管理者と社長のベルに1行（スマホは鳴らさない＝event_key なし）。何も無い日は何も届かない
-- ・点検の中身（admin_health_check）：自動の処理（cron）の失敗／毎分の処理の中の失敗／自動の処理からのサーバー呼び出しの失敗／
--   スマホ通知の送信失敗・送れずに残っているもの／連絡板のメールの送信失敗／データベースの大きさ（400MB で確認が要る）
-- ・管理画面 →［使用量 ▼］の「点検」の欄が同じ関数を読む（画面で判定し直さない）
-- ・ログの量（Log Ingestion）は Supabase の画面にしか無いので、ここでは見られない

begin;

-- ── 毎分の処理の中の失敗・呼び出しの失敗の記録（30日で消す） ──
create table if not exists public.system_health_events (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  kind text not null check (kind in ('cron', 'net')),
  message text,
  n integer not null default 1
);
create index if not exists system_health_events_at on public.system_health_events (at);
alter table public.system_health_events enable row level security;
revoke all on public.system_health_events from anon, authenticated;
grant all on public.system_health_events to service_role;

-- 記録する（失敗しても呼んだ処理を止めない）
create or replace function public.health_note(p_kind text, p_message text, p_n integer default 1)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  insert into system_health_events (kind, message, n) values (p_kind, left(p_message, 500), coalesce(p_n, 1));
exception when others then null;
end;
$function$;
revoke execute on function public.health_note(text, text, integer) from public;
revoke execute on function public.health_note(text, text, integer) from anon;
revoke execute on function public.health_note(text, text, integer) from authenticated;

-- ── 点検（1か所）：p_day＝JST の日付。既定はきのう ──
create or replace function public.admin_health_check(p_day date default null)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_day date := coalesce(p_day, (now() at time zone 'Asia/Tokyo')::date - 1);
  v_from timestamptz := (v_day::timestamp at time zone 'Asia/Tokyo');
  v_to timestamptz := ((v_day + 1)::timestamp at time zone 'Asia/Tokyo');
  v_cron_total int; v_cron_failed int; v_cron_list jsonb;
  v_inner int; v_inner_list jsonb;
  v_net int;
  v_pq_failed int; v_pq_users int; v_pq_list jsonb;
  v_pd_failed int;
  v_stuck int;
  v_mail_failed int; v_mail_list jsonb;
  v_db_mb int;
  v_issues int := 0;
begin
  -- 🚨 見られるのは管理者と社長だけ（毎朝のお知らせの関数は cron から呼ぶ＝auth.uid() が無い）
  if auth.uid() is not null and not (
       is_admin()
       or exists (select 1 from profiles p join roles r on r.id = p.role_id where p.id = auth.uid() and r.acts_as = 'president')) then
    raise exception '権限がありません' using errcode = '42501';
  end if;

  select count(*), count(*) filter (where d.status = 'failed')
    into v_cron_total, v_cron_failed
    from cron.job_run_details d where d.start_time >= v_from and d.start_time < v_to;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_cron_list from (
    select j.jobname as name, to_char(d.start_time at time zone 'Asia/Tokyo', 'HH24:MI') as at, left(d.return_message, 200) as message
      from cron.job_run_details d left join cron.job j on j.jobid = d.jobid
     where d.start_time >= v_from and d.start_time < v_to and d.status = 'failed'
     order by d.start_time desc limit 10) x;

  select count(*) into v_inner from system_health_events e where e.kind = 'cron' and e.at >= v_from and e.at < v_to;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_inner_list from (
    select to_char(e.at at time zone 'Asia/Tokyo', 'HH24:MI') as at, e.message
      from system_health_events e where e.kind = 'cron' and e.at >= v_from and e.at < v_to
     order by e.at desc limit 10) x;
  select coalesce(sum(e.n), 0) into v_net from system_health_events e where e.kind = 'net' and e.at >= v_from and e.at < v_to;

  select count(*), count(distinct q.user_id) into v_pq_failed, v_pq_users
    from push_queue q where q.status = 'failed' and q.created_at >= v_from and q.created_at < v_to;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_pq_list from (
    select q.event_key, to_char(q.created_at at time zone 'Asia/Tokyo', 'HH24:MI') as at, left(q.error, 160) as error
      from push_queue q where q.status = 'failed' and q.created_at >= v_from and q.created_at < v_to
     order by q.created_at desc limit 10) x;
  select count(*) into v_pd_failed from push_deferred d where d.status = 'failed' and d.created_at >= v_from and d.created_at < v_to;
  -- 送れずに残っている：1日より前にできて、まだ pending で、相手がいまミュート中ではないもの
  -- （休みの日・受信時間外で待っている分は数えない＝毎朝 9:05 に見るので、休みの日の分は 9:00 に届いたあと）
  select count(*) into v_stuck from (
    select user_id from push_queue where status = 'pending' and created_at < now() - interval '1 day'
    union all
    select user_id from push_deferred where status = 'pending' and created_at < now() - interval '1 day'
  ) s
  where not (s.user_id = any (push_muted_user_ids(array[s.user_id])));

  select count(*) into v_mail_failed from board_email_queue m
   where m.sent_at is null and m.error is not null and m.attempts >= 3 and m.created_at >= v_from and m.created_at < v_to;
  select coalesce(jsonb_agg(x), '[]'::jsonb) into v_mail_list from (
    select m.event_key, to_char(m.created_at at time zone 'Asia/Tokyo', 'HH24:MI') as at, left(m.error, 160) as error
      from board_email_queue m
     where m.sent_at is null and m.error is not null and m.attempts >= 3 and m.created_at >= v_from and m.created_at < v_to
     order by m.created_at desc limit 10) x;

  v_db_mb := (pg_database_size(current_database()) / 1024 / 1024)::int;

  v_issues := (case when v_cron_failed > 0 then 1 else 0 end) + (case when v_inner > 0 then 1 else 0 end)
            + (case when v_net > 0 then 1 else 0 end) + (case when v_pq_failed + v_pd_failed > 0 then 1 else 0 end)
            + (case when v_stuck > 0 then 1 else 0 end) + (case when v_mail_failed > 0 then 1 else 0 end)
            + (case when v_db_mb >= 400 then 1 else 0 end);

  return jsonb_build_object(
    'day', v_day,
    'issues', v_issues,
    'cron', jsonb_build_object('total', v_cron_total, 'failed', v_cron_failed, 'list', v_cron_list),
    'inner', jsonb_build_object('count', v_inner, 'list', v_inner_list),
    'net', jsonb_build_object('failed', v_net),
    'push', jsonb_build_object('failed', v_pq_failed + v_pd_failed, 'users', v_pq_users, 'stuck', v_stuck, 'list', v_pq_list),
    'mail', jsonb_build_object('failed', v_mail_failed, 'list', v_mail_list),
    'db', jsonb_build_object('mb', v_db_mb, 'limit_mb', 500));
end;
$function$;
revoke execute on function public.admin_health_check(date) from public;
revoke execute on function public.admin_health_check(date) from anon;
grant execute on function public.admin_health_check(date) to authenticated;

-- ── 毎朝 9:05：確認が要ることがあれば、管理者と社長のベルへ（1人1日1通） ──
create or replace function public.health_daily_notify()
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v jsonb := admin_health_check(null);
  v_parts text[] := '{}';
  v_sub text;
begin
  if coalesce((v->>'issues')::int, 0) = 0 then return; end if;
  if (v->'cron'->>'failed')::int > 0 then v_parts := v_parts || ('自動の処理の失敗 ' || (v->'cron'->>'failed') || '件'); end if;
  if (v->'inner'->>'count')::int > 0 then v_parts := v_parts || ('毎分の処理の中の失敗 ' || (v->'inner'->>'count') || '件'); end if;
  if (v->'net'->>'failed')::int > 0 then v_parts := v_parts || ('サーバー呼び出しの失敗 ' || (v->'net'->>'failed') || '件'); end if;
  if (v->'push'->>'failed')::int > 0 then v_parts := v_parts || ('スマホ通知の送信失敗 ' || (v->'push'->>'failed') || '件'); end if;
  if (v->'push'->>'stuck')::int > 0 then v_parts := v_parts || ('送れずに残っているスマホ通知 ' || (v->'push'->>'stuck') || '件'); end if;
  if (v->'mail'->>'failed')::int > 0 then v_parts := v_parts || ('連絡板のメールの送信失敗 ' || (v->'mail'->>'failed') || '件'); end if;
  if (v->'db'->>'mb')::int >= 400 then v_parts := v_parts || ('データベースの大きさ ' || (v->'db'->>'mb') || 'MB／500MB'); end if;
  v_sub := array_to_string(v_parts, '・');

  insert into notifications (user_id, message, sub_message, source_type, reference_id, read)
  select p.id,
         '⚠️ きのうの自動の点検で、確認が要ることが' || (v->>'issues') || '件あります',
         v_sub, 'health:daily', (v->>'day'), false
    from profiles p join roles r on r.id = p.role_id
   where p.is_active and (r.is_fixed or r.acts_as = 'president')
     and not exists (select 1 from notifications n
                      where n.user_id = p.id and n.source_type = 'health:daily' and n.reference_id = (v->>'day'));
end;
$function$;
revoke execute on function public.health_daily_notify() from public;
revoke execute on function public.health_daily_notify() from anon;
revoke execute on function public.health_daily_notify() from authenticated;

-- ── 毎分の1本（20261103192555 の版から：失敗を記録する・毎時7分に呼び出しの失敗を数える・9:00 に点検・3:07 に記録の片付け） ──
create or replace function public.cron_every_minute()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_jst timestamp := (now() at time zone 'Asia/Tokyo');
  v_min int := extract(minute from v_jst)::int;
  v_hm text := to_char(v_jst, 'HH24:MI');
  v_n int;
begin
  begin
    perform board_deliver_due();
    perform board_kick_email();
  exception when others then
    raise warning '[cron_every_minute] 連絡板の届けに失敗: %', sqlerrm;
    perform health_note('cron', '連絡板の届け: ' || sqlerrm);
  end;

  -- 5分ごと（元は別々の cron。1本ずつ包み、1本が失敗してもほかは動く）
  if v_min % 5 = 0 then
    begin perform hire_checklist_notify();      exception when others then perform health_note('cron', 'hire_checklist_notify: ' || sqlerrm); end;
    begin perform cron_safety_check_remind();   exception when others then perform health_note('cron', 'cron_safety_check_remind: ' || sqlerrm); end;
    begin perform cron_remind_scheduled();      exception when others then perform health_note('cron', 'cron_remind_scheduled: ' || sqlerrm); end;
    begin perform cron_remind_unread();         exception when others then perform health_note('cron', 'cron_remind_unread: ' || sqlerrm); end;
    begin perform cron_encouragement_notify();  exception when others then perform health_note('cron', 'cron_encouragement_notify: ' || sqlerrm); end;
    begin perform staff_leave_daily_notices();  exception when others then perform health_note('cron', 'staff_leave_daily_notices: ' || sqlerrm); end;
  end if;

  -- 15分ごと
  if v_min % 15 = 0 then
    begin perform shift_adjust_send_digest();      exception when others then perform health_note('cron', 'shift_adjust_send_digest: ' || sqlerrm); end;
    begin perform shift_adjust_notify_plan_due();  exception when others then perform health_note('cron', 'shift_adjust_notify_plan_due: ' || sqlerrm); end;
    begin
      if exists (select 1 from profiles
                  where invite_scheduled_for is not null and invite_scheduled_for <= now()
                    and email not like '%.invalid') then
        perform cron_call_edge('staff-onboard', jsonb_build_object('action', 'send_due'));
      end if;
    exception when others then perform health_note('cron', 'staff-invite-due: ' || sqlerrm); end;
    begin
      if exists (select 1 from pw_change_requests
                  where scheduled_for is not null and scheduled_for <= now()
                    and sent_at is null and cancelled_at is null) then
        perform cron_call_edge('staff-onboard', jsonb_build_object('action', 'send_due_pw'));
      end if;
    exception when others then perform health_note('cron', 'pw-request-due: ' || sqlerrm); end;
    -- 休暇のシフト調整のお知らせ：設定の送る時刻の間だけ（Edge Function の最初の確かめと同じ・既定 09:10 から120分・設定が無い／読めないときは呼ぶ）
    begin
      if coalesce((
           select s.enabled is distinct from false
                  and v_jst::time >= coalesce(s.send_time::time, time '09:10')
                  and v_jst::time <  coalesce(s.send_time::time, time '09:10') + make_interval(mins => coalesce(s.window_minutes, 120))
             from leave_shift_alert_settings s where s.id = 1), true) then
        perform cron_call_edge('remind-leave-shift-adjust');
      end if;
    exception when others then
      perform health_note('cron', 'remind-leave-shift-adjust: ' || sqlerrm);
      begin perform cron_call_edge('remind-leave-shift-adjust'); exception when others then null; end;
    end;
  end if;

  -- 毎時7分：この1時間の、自動の処理からのサーバー呼び出しの失敗を数える（呼び出しの結果は約6時間で消えるため）
  if v_min = 7 then
    begin
      select count(*) into v_n from net._http_response r
       where r.created >= now() - interval '1 hour'
         and (r.timed_out or r.error_msg is not null or r.status_code is null or r.status_code >= 400);
      if v_n > 0 then perform health_note('net', 'この1時間の呼び出しの失敗', v_n); end if;
    exception when others then null;
    end;
  end if;

  -- 毎朝 9:05：きのうの点検（確認が要ることがあれば管理者と社長のベルへ）。9:00 の休みの日の分の配達のあとに見る
  if v_hm = '09:05' then
    begin perform health_daily_notify(); exception when others then raise warning '[cron_every_minute] health_daily_notify: %', sqlerrm; end;
  end if;

  -- 毎晩 3:07（JST）：7日を過ぎた送信待ちの片付け（ベル・メールには残っている）・点検の記録は30日
  if v_hm = '03:07' then
    begin
      update push_queue set status = 'skipped', error = coalesce(error, '7日を過ぎたため送らない')
       where status = 'pending' and created_at < now() - interval '7 days';
      delete from push_queue where status in ('sent', 'skipped') and created_at < now() - interval '7 days';
      delete from push_deferred where created_at < now() - interval '7 days';
      delete from system_health_events where at < now() - interval '30 days';
    exception when others then perform health_note('cron', '送信待ちの片付け: ' || sqlerrm); end;
  end if;

  -- 送信係：いま送れる行があるときだけ
  if push_dispatch_due() then
    perform cron_call_edge('push-dispatch');
  end if;
end;
$function$;

commit;
