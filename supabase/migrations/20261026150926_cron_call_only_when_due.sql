-- 5分ごとの Edge Function 5本を「送るものがあるときだけ」呼ぶ（2026-10-26・Supabase の Log Ingestion の無料枠 1GB/月を超えていたため）
-- ・今は送るものが無くても毎回呼んでいた（1日 約1,440回）。そのたびに入口の確認・設定の読み込み・関数の記録が残り、記録の量の約半分を占めていた
-- ・10/18 の push-dispatch-every-min と同じ考え方。🚨 送る時刻・送る中身は変えない（判定は各 Edge Function の条件をそのまま写した）
--   board-scheduled-send … 予約時刻を過ぎた予約投稿があるとき（本体の UPDATE の条件と同じ・遅れても次の回で拾う作り）
--   safety-check-remind  … 再送する安否確認があるとき（条件は safety_check_remind_due 1か所。claim_safety_check_reminders も同じものを使う）
--   remind-scheduled     … 今の JST の時・分に、有効な定期リマインドがあるとき（日・月の判定は本体のまま。ここでは見ない）
--   remind-unread / encouragement-notify … 今の JST の時・分が設定の送信時刻のとき（設定が無ければ 9:00・本体と同じ）
--   🚨 3本（決まった1分に送る作り）は、日付や投稿の有無まではここで見ない（本体は UTC の日付で数える癖があり、まねると食い違う恐れがあるため）
-- ・cron の記録に残る文を短くするため、判定と呼び出しは関数にまとめた
-- 🚨 戻すとき：各ジョブの command を元に戻す（元の文はこのファイルの最後）

-- 呼び出しの部品（鍵は vault から。いままでの cron と同じ）
create or replace function public.cron_call_edge(p_fn text, p_body jsonb default null)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id bigint;
begin
  select net.http_post(
    url := 'https://xaeynaxctiiyqxjyuzfi.supabase.co/functions/v1/' || p_fn,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')),
    body := coalesce(p_body, jsonb_build_object('triggered_at', now()))
  ) into v_id;
  return v_id;
end;
$$;
revoke execute on function public.cron_call_edge(text, jsonb) from public;
revoke execute on function public.cron_call_edge(text, jsonb) from anon;
revoke execute on function public.cron_call_edge(text, jsonb) from authenticated;

-- 安否確認の再送の条件（claim と cron で1か所）
create or replace function public.safety_check_remind_due(s public.safety_checks, p_now timestamptz, p_hour_jst integer)
returns boolean
language sql
stable
set search_path = public
as $$
  select s.status = 'active'
     and s.cancelled = false
     and s.next_remind_at is not null
     and s.next_remind_at <= p_now
     and s.remind_count < s.remind_max
     and p_hour_jst >= s.remind_start_hour
     and p_hour_jst <  s.remind_end_hour;
$$;
revoke execute on function public.safety_check_remind_due(public.safety_checks, timestamptz, integer) from public;
revoke execute on function public.safety_check_remind_due(public.safety_checks, timestamptz, integer) from anon;
revoke execute on function public.safety_check_remind_due(public.safety_checks, timestamptz, integer) from authenticated;

-- 本番の実定義から。where の7つの条件を safety_check_remind_due に置き換えただけ（中身は同じ）
create or replace function public.claim_safety_check_reminders(p_now timestamp with time zone, p_hour_jst integer)
 returns table(id uuid, pattern text)
 language sql
 security definer
 set search_path to 'public'
as $function$
  update safety_checks
     set remind_count = remind_count + 1,
         next_remind_at = case
           when remind_count + 1 >= remind_max then null
           else p_now + make_interval(mins => remind_interval_min)
         end
   where public.safety_check_remind_due(safety_checks, p_now, p_hour_jst)
  returning safety_checks.id, safety_checks.pattern;
$function$;
revoke execute on function public.claim_safety_check_reminders(timestamptz, integer) from public, anon, authenticated;
grant  execute on function public.claim_safety_check_reminders(timestamptz, integer) to service_role;

-- 5本の判定つきの呼び出し（cron から呼ぶ・返り値は呼んだら request id、呼ばなければ null）
create or replace function public.cron_board_scheduled_send()
returns bigint language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from board_messages where status = 'scheduled' and scheduled_at <= now()) then
    return cron_call_edge('board-scheduled-send');
  end if;
  return null;
end; $$;

create or replace function public.cron_safety_check_remind()
returns bigint language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from safety_checks s
             where safety_check_remind_due(s, now(), extract(hour from (now() at time zone 'Asia/Tokyo'))::int)) then
    return cron_call_edge('safety-check-remind');
  end if;
  return null;
end; $$;

create or replace function public.cron_remind_scheduled()
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_jst timestamp := now() at time zone 'Asia/Tokyo';
begin
  if exists (select 1 from board_scheduled_reminders
             where is_active
               and send_hour = extract(hour from v_jst)::int
               and send_minute = extract(minute from v_jst)::int) then
    return cron_call_edge('remind-scheduled');
  end if;
  return null;
end; $$;

-- 設定の行が無ければ 9:00（本体の既定と同じ）
create or replace function public.cron_send_time_is_now(p_event_key text)
returns boolean language sql stable set search_path = public as $$
  select coalesce((select send_hour from reminder_days_settings where event_key = p_event_key), 9)
           = extract(hour from (now() at time zone 'Asia/Tokyo'))::int
     and coalesce((select send_minute from reminder_days_settings where event_key = p_event_key), 0)
           = extract(minute from (now() at time zone 'Asia/Tokyo'))::int;
$$;

create or replace function public.cron_remind_unread()
returns bigint language plpgsql security definer set search_path = public as $$
begin
  if cron_send_time_is_now('remind_unread') then
    return cron_call_edge('remind-unread');
  end if;
  return null;
end; $$;

create or replace function public.cron_encouragement_notify()
returns bigint language plpgsql security definer set search_path = public as $$
begin
  if cron_send_time_is_now('encouragement_notify') then
    return cron_call_edge('encouragement-notify');
  end if;
  return null;
end; $$;

do $$
declare f text;
begin
  foreach f in array array['cron_board_scheduled_send()','cron_safety_check_remind()','cron_remind_scheduled()',
                           'cron_send_time_is_now(text)','cron_remind_unread()','cron_encouragement_notify()'] loop
    execute format('revoke execute on function public.%s from public', f);
    execute format('revoke execute on function public.%s from anon', f);
    execute format('revoke execute on function public.%s from authenticated', f);
  end loop;
end $$;

-- cron のジョブの中身を差し替える（名前・間隔はそのまま）
select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'board-scheduled-send-every-5-min'), command := 'select public.cron_board_scheduled_send()');
select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'safety-check-remind-every-5-min'), command := 'select public.cron_safety_check_remind()');
select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'remind-scheduled-daily'), command := 'select public.cron_remind_scheduled()');
select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'remind-unread-daily'), command := 'select public.cron_remind_unread()');
select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'encouragement-notify-daily'), command := 'select public.cron_encouragement_notify()');

-- 元の command（戻すとき・5本とも同じ形で、関数の名前だけ違う）
--  select net.http_post( url := 'https://xaeynaxctiiyqxjyuzfi.supabase.co/functions/v1/<関数名>',
--    headers := jsonb_build_object( 'Content-Type', 'application/json',
--      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key') ),
--    body := jsonb_build_object('triggered_at', now()) ) as request_id;
--  <関数名>：board-scheduled-send／safety-check-remind／remind-scheduled／remind-unread／encouragement-notify
