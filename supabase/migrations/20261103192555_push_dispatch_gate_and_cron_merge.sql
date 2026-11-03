-- ログの量を減らす 1段・2段（2026-11-03 ユーザー確定・UI/UX とシニアエンジニアの2体で調べた結果）
--
-- 1段：スマホ通知の送信係（Edge Function push-dispatch）の空回りを止める
--   ・これまで：push_queue／push_deferred に pending が1件でもあれば毎分呼んでいた。
--     受信時間外・休みの日のミュート中の人の行は pending のまま残る作りなので、1人でもミュート中の人あての行があると
--     毎分動き、毎回9〜11本を読み書きしていた（1日 約13,000件＝API の入口のログの約半分・11/3 の実測）
--   ・これから：push_dispatch_due() が「いま送れる行」があるときだけ呼ぶ（緊急・ミュートでない人・休職で片付ける行・できたばかりの行）
--   ・7日を過ぎた行の片付けは毎晩 3:07（JST）に DB で（門を絞ると、ずっとミュートの人の古い行が残って、外れたときに古い通知が鳴るため）
--   ・push_deferred の送信の失敗は3回で諦める（retry_count・error・Edge Function で数える）
-- 休みの日の通知は翌朝 9:00 に（ユーザー確定・毎朝のお知らせと同じ時刻）：
--   ・これまで：休みの日（mute_on_leave）は日付が変わった 0:00 に外れ、夜中にまとめて鳴っていた
--   ・これから：休みの日の次の日は 9:00 まで鳴らさない（次の日も休みならその日も鳴らさない・受信時間の設定があれば遅いほう）
-- 2段：5分ごと・15分ごとの自動の処理（cron）を毎分の1本（cron_every_minute）の中にまとめる
--   ・cron は1回動くたびに「starting」「completed」の2行のログが残る（1日 約7,300行）。まとめると約4,000行減る。動く時刻は同じ（分が5／15で割り切れるとき）
--   ・remind-leave-shift-adjust は、設定の送る時刻（send_time〜window_minutes）の間だけ呼ぶ（判定は Edge Function の最初の確かめと同じ・中身の判定は今までどおり Edge Function）
--
-- 🚨 戻すとき：下の cron.unschedule した11本を、ファイルの最後に書いた元の command で cron.schedule し直し、cron_every_minute を 20261026193037 の版に戻す

begin;

-- ── 休みの日かどうか（push_muted_user_ids の (b) をそのまま出した・本番の実定義から） ──
create or replace function public.push_leave_mute_day(p_user uuid, p_day date)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select exists (select 1 from company_calendar cc where cc.date = p_day and cc.kind = 'closed_all')
      or exists (
        select 1 from leave_requests lr
         where lr.user_id = p_user
           and lr.status = 'approved'
           and (
             (lr.leave_dates is not null
               and lr.leave_dates ~ '^\s*\['
               and lr.leave_dates::jsonb ? to_char(p_day, 'YYYY-MM-DD'))
             or (lr.leave_dates is null
               and lr.start_date is not null and lr.end_date is not null
               and lr.start_date <= p_day and lr.end_date >= p_day)
           ))
      or exists (
        select 1 from overtime_reports ot
         where ot.applicant_id = p_user
           and ot.work_date = p_day
           and ot.status in ('request_confirmed','reported','confirmed')
           and ot.application_types && array['chosei_off','furikae_off','absence']);
$function$;
revoke execute on function public.push_leave_mute_day(uuid, date) from public;
revoke execute on function public.push_leave_mute_day(uuid, date) from anon;
revoke execute on function public.push_leave_mute_day(uuid, date) from authenticated;

-- ── ミュートの判定（本番の実定義から・(b) に「休みの日の次の日の 9:00 まで」を足した） ──
create or replace function public.push_muted_user_ids(p_user_ids uuid[])
 returns uuid[]
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  v_now_jst timestamp := (now() at time zone 'Asia/Tokyo');
  v_time time := v_now_jst::time;
  v_today date := v_now_jst::date;
  v_muted uuid[];
begin
  select coalesce(array_agg(p.user_id), '{}'::uuid[]) into v_muted
  from push_preferences p
  where p.user_id = any(p_user_ids)
    and (
      -- (a) 受信時間帯の外
      (p.quiet_enabled
        and p.receive_start is not null
        and p.receive_end is not null
        and p.receive_start <> p.receive_end
        and case
          when p.receive_start < p.receive_end
            then not (v_time >= p.receive_start and v_time < p.receive_end)
          else     (v_time >= p.receive_end   and v_time < p.receive_start)
        end)
      or
      -- (b) 休暇日（本人の受理済み休暇・終日の休み・会社の全社休み）。
      --     休みの日の次の日は 9:00 まで鳴らさない（夜中の 0:00 にまとめて鳴らないように・2026-11-03 ユーザー確定）
      (p.mute_on_leave and (
        push_leave_mute_day(p.user_id, v_today)
        or (v_time < time '09:00' and push_leave_mute_day(p.user_id, v_today - 1))
      ))
    );
  return v_muted;
exception when others then
  -- fail-open: 判定に失敗したら「誰もミュートしない」＝送る
  return '{}'::uuid[];
end $function$;

-- ── 送信係を呼ぶか（毎分の門・1か所） ──
-- 🚨 緊急の判定は push-dispatch の isUrgent（行の urgent・EVENT_MAP の urgent・safety: で始まる）と同じ。
--    EVENT_MAP で urgent を付けているのは safety:urgent だけ（safety: に含まれる）。ほかに付けるならここにも足す
--    （足し忘れても ⑤ のできたばかりの行の網で、最初の2分は必ず1回は呼ぶ）
create or replace function public.push_dispatch_due()
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_since timestamptz := now() - interval '7 days';
  v_users uuid[];
  v_muted uuid[];
  v_blocked uuid[];
begin
  -- ⑤ できたばかりの行（2分以内）は必ず1回見せる
  if exists (select 1 from push_queue where status = 'pending' and created_at > now() - interval '2 minutes')
     or exists (select 1 from push_deferred where status = 'pending' and created_at > now() - interval '2 minutes') then
    return true;
  end if;
  -- ① 緊急（相手がミュート中でも送る）
  if exists (select 1 from push_queue
              where status = 'pending' and created_at > v_since
                and (urgent is true or event_key like 'safety:%')) then
    return true;
  end if;
  select array_agg(distinct u) into v_users from (
    select user_id as u from push_queue where status = 'pending' and created_at > v_since
    union
    select user_id from push_deferred where status = 'pending' and created_at > v_since
  ) x;
  if v_users is null then return false; end if;
  v_muted := push_muted_user_ids(v_users);
  select array_agg(b) into v_blocked from push_leave_blocked_ids(v_users) b;
  -- ②③ ミュート中でない人の行がある／④ 休職で受け取らない人の行がある（片付ける）
  return exists (
    select 1 from unnest(v_users) u
     where not (u = any (coalesce(v_muted, '{}'::uuid[])))
        or u = any (coalesce(v_blocked, '{}'::uuid[])));
exception when others then
  return true;   -- fail-open（呼んで Edge Function に判断させる）
end;
$function$;
revoke execute on function public.push_dispatch_due() from public;
revoke execute on function public.push_dispatch_due() from anon;
revoke execute on function public.push_dispatch_due() from authenticated;

-- ── 保留分の送信の失敗を数える（3回で諦める・push-dispatch が書く） ──
alter table public.push_deferred add column if not exists retry_count integer not null default 0;
alter table public.push_deferred add column if not exists error text;

-- ── 毎分の1本（本番の実定義から：連絡板の届け→（5分・15分の処理）→毎晩の片付け→送信係の門） ──
create or replace function public.cron_every_minute()
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_jst timestamp := (now() at time zone 'Asia/Tokyo');
  v_min int := extract(minute from v_jst)::int;
begin
  begin
    perform board_deliver_due();
    perform board_kick_email();
  exception when others then
    raise warning '[cron_every_minute] 連絡板の届けに失敗: %', sqlerrm;
  end;

  -- 5分ごと（元は別々の cron。1本ずつ包み、1本が失敗してもほかは動く）
  if v_min % 5 = 0 then
    begin perform hire_checklist_notify();      exception when others then raise warning '[cron_every_minute] hire_checklist_notify: %', sqlerrm; end;
    begin perform cron_safety_check_remind();   exception when others then raise warning '[cron_every_minute] cron_safety_check_remind: %', sqlerrm; end;
    begin perform cron_remind_scheduled();      exception when others then raise warning '[cron_every_minute] cron_remind_scheduled: %', sqlerrm; end;
    begin perform cron_remind_unread();         exception when others then raise warning '[cron_every_minute] cron_remind_unread: %', sqlerrm; end;
    begin perform cron_encouragement_notify();  exception when others then raise warning '[cron_every_minute] cron_encouragement_notify: %', sqlerrm; end;
    begin perform staff_leave_daily_notices();  exception when others then raise warning '[cron_every_minute] staff_leave_daily_notices: %', sqlerrm; end;
  end if;

  -- 15分ごと
  if v_min % 15 = 0 then
    begin perform shift_adjust_send_digest();      exception when others then raise warning '[cron_every_minute] shift_adjust_send_digest: %', sqlerrm; end;
    begin perform shift_adjust_notify_plan_due();  exception when others then raise warning '[cron_every_minute] shift_adjust_notify_plan_due: %', sqlerrm; end;
    begin
      if exists (select 1 from profiles
                  where invite_scheduled_for is not null and invite_scheduled_for <= now()
                    and email not like '%.invalid') then
        perform cron_call_edge('staff-onboard', jsonb_build_object('action', 'send_due'));
      end if;
    exception when others then raise warning '[cron_every_minute] staff-invite-due: %', sqlerrm; end;
    begin
      if exists (select 1 from pw_change_requests
                  where scheduled_for is not null and scheduled_for <= now()
                    and sent_at is null and cancelled_at is null) then
        perform cron_call_edge('staff-onboard', jsonb_build_object('action', 'send_due_pw'));
      end if;
    exception when others then raise warning '[cron_every_minute] pw-request-due: %', sqlerrm; end;
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
      raise warning '[cron_every_minute] remind-leave-shift-adjust: %', sqlerrm;
      begin perform cron_call_edge('remind-leave-shift-adjust'); exception when others then null; end;
    end;
  end if;

  -- 毎晩 3:07（JST）：7日を過ぎた送信待ちの片付け（ベル・メールには残っている）
  if to_char(v_jst, 'HH24:MI') = '03:07' then
    begin
      update push_queue set status = 'skipped', error = coalesce(error, '7日を過ぎたため送らない')
       where status = 'pending' and created_at < now() - interval '7 days';
      delete from push_queue where status in ('sent', 'skipped') and created_at < now() - interval '7 days';
      delete from push_deferred where created_at < now() - interval '7 days';
    exception when others then raise warning '[cron_every_minute] 送信待ちの片付け: %', sqlerrm; end;
  end if;

  -- 送信係：いま送れる行があるときだけ
  if push_dispatch_due() then
    perform cron_call_edge('push-dispatch');
  end if;
end;
$function$;

-- ── まとめた11本の cron を止める ──
select cron.unschedule('hire-checklist-notify');
select cron.unschedule('safety-check-remind-every-5-min');
select cron.unschedule('remind-scheduled-daily');
select cron.unschedule('remind-unread-daily');
select cron.unschedule('encouragement-notify-daily');
select cron.unschedule('staff-leave-daily-notices');
select cron.unschedule('shift-adjust-digest');
select cron.unschedule('shift-adjust-plan-due');
select cron.unschedule('staff-invite-due');
select cron.unschedule('pw-request-due');
select cron.unschedule('remind-leave-shift-adjust-daily');

commit;

-- 【戻すときの元の command（2026-11-03 本番から写した）】
--  hire-checklist-notify              */5  select public.hire_checklist_notify();
--  safety-check-remind-every-5-min    */5  select public.cron_safety_check_remind()
--  remind-scheduled-daily             */5  select public.cron_remind_scheduled()
--  remind-unread-daily                */5  select public.cron_remind_unread()
--  encouragement-notify-daily         */5  select public.cron_encouragement_notify()
--  staff-leave-daily-notices          */5  select public.staff_leave_daily_notices()
--  shift-adjust-digest                */15 select public.shift_adjust_send_digest();
--  shift-adjust-plan-due              */15 select public.shift_adjust_notify_plan_due();
--  staff-invite-due                   */15 select net.http_post(url := '…/functions/v1/staff-onboard', headers := …service_role_key…, body := jsonb_build_object('action','send_due')) as request_id
--                                          where exists (select 1 from public.profiles where invite_scheduled_for is not null and invite_scheduled_for <= now() and email not like '%.invalid');
--  pw-request-due                     */15 select net.http_post(url := '…/functions/v1/staff-onboard', …, body := jsonb_build_object('action','send_due_pw')) as request_id
--                                          where exists (select 1 from public.pw_change_requests where scheduled_for is not null and scheduled_for <= now() and sent_at is null and cancelled_at is null);
--  remind-leave-shift-adjust-daily    */15 select net.http_post(url := '…/functions/v1/remind-leave-shift-adjust', …, body := jsonb_build_object('triggered_at', now())) as request_id;
--  （net.http_post の headers は cron_call_edge と同じ：Content-Type と Authorization: Bearer <vault の service_role_key>）
