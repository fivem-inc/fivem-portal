-- ログインの記録・端末ごとの強制ログアウト・パソコンの長期未使用ログアウト（2026-10-16 ユーザー確定）
--
-- 【何をするか】
-- ・session_devices：ログイン（auth.sessions の1行）ごとに「どの端末か」（端末番号・パソコン／スマホ・ブラウザ・共有パソコンのチェック）。
--   画面が開いたときに record_session_device で書く（同じログインなら上書き）。初めて見たログインのときだけ login_events に「ログイン」を1行
-- ・login_events：ログイン／ログアウト／自動ログアウト（共有パソコン）／強制ログアウト（管理者）／長期未使用のログアウト の記録。90日で消す
-- ・admin_user_sessions：その人のいまログインしている端末の一覧（管理者だけ）
-- ・admin_force_logout：その端末のログインを消す＋その端末のスマホ通知の登録も消す（管理者だけ・パソコンもスマホも）
-- ・purge_idle_pc_sessions：パソコンのログイン（端末が分からない古いものは Windows だけ）で、最後に使ってから N 日（app_settings 'pc_idle_session_days'・既定30・0で止める）たったものを消す。
--   🚨 スマホ・タブレットは対象外（ユーザー確定）。共有パソコンも対象（もともと短時間で自動ログアウトしているので影響なし）
-- ・push_subscriptions.device_id：通知の登録がどの端末のものか（強制ログアウトでその端末の通知も止めるため）
--
-- 🚨 表は画面から直接は書けない（関数だけ）。読めるのは管理者だけ
-- 🚨 ログインの時刻は auth.sessions.created_at（本当にログインした時刻）を使う。この機能を出す前からのログインも、初めて開いたときに記録される

begin;

create table if not exists public.session_devices (
  session_id    uuid primary key,
  user_id       uuid not null references auth.users(id) on delete cascade,
  device_id     text not null check (char_length(device_id) between 8 and 64),
  device_kind   text not null check (device_kind in ('pc', 'phone', 'tablet')),
  device_label  text not null check (char_length(device_label) <= 80),
  shared_pc     boolean not null default false,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);
create index if not exists session_devices_user_idx on public.session_devices (user_id);
alter table public.session_devices enable row level security;
drop policy if exists session_devices_admin_select on public.session_devices;
create policy session_devices_admin_select on public.session_devices for select to authenticated using (is_admin());

create table if not exists public.login_events (
  id           bigint generated always as identity primary key,
  user_id      uuid not null references auth.users(id) on delete cascade,
  event        text not null check (event in ('login', 'logout', 'idle_logout', 'forced_logout', 'expired_logout')),
  at           timestamptz not null default now(),
  session_id   uuid,
  device_id    text,
  device_kind  text,
  device_label text,
  shared_pc    boolean,
  actor_id     uuid
);
create index if not exists login_events_at_idx on public.login_events (at desc);
create index if not exists login_events_user_idx on public.login_events (user_id, at desc);
create index if not exists login_events_session_idx on public.login_events (session_id);
alter table public.login_events enable row level security;
drop policy if exists login_events_admin_select on public.login_events;
create policy login_events_admin_select on public.login_events for select to authenticated using (is_admin());

alter table public.push_subscriptions add column if not exists device_id text;

-- 画面が開いたとき（ログイン中）に呼ぶ。p_endpoint はこの端末の通知の登録（あれば端末番号を付ける）
create or replace function public.record_session_device(
  p_device_id text, p_device_kind text, p_device_label text, p_shared boolean, p_endpoint text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_sid uuid;
  v_created timestamptz;
  v_new int;
  v_kind text := case when p_device_kind in ('pc', 'phone', 'tablet') then p_device_kind else 'pc' end;
  v_label text := left(coalesce(nullif(trim(p_device_label), ''), '不明'), 80);
  v_dev text := left(coalesce(p_device_id, ''), 64);
  v_push_missing boolean := false;
begin
  if v_uid is null or char_length(v_dev) < 8 then return '{}'::jsonb; end if;
  begin
    v_sid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  exception when others then
    return '{}'::jsonb;
  end;
  if v_sid is null then return '{}'::jsonb; end if;
  -- 🚨 消されたログイン（強制ログアウトなど）では何もしない（通行証の残り時間で呼ばれても記録を作り直さない）
  select s.created_at into v_created from auth.sessions s where s.id = v_sid and s.user_id = v_uid;
  if not found then return '{}'::jsonb; end if;

  insert into public.session_devices (session_id, user_id, device_id, device_kind, device_label, shared_pc)
  values (v_sid, v_uid, v_dev, v_kind, v_label, coalesce(p_shared, false))
  on conflict (session_id) do nothing;
  get diagnostics v_new = row_count;

  if v_new = 1 then
    -- 初めて見たログイン：時刻は本当にログインした時刻
    insert into public.login_events (user_id, event, at, session_id, device_id, device_kind, device_label, shared_pc)
    values (v_uid, 'login', coalesce(v_created, now()), v_sid, v_dev, v_kind, v_label, coalesce(p_shared, false));
  else
    update public.session_devices
       set device_id = v_dev, device_kind = v_kind, device_label = v_label, shared_pc = coalesce(p_shared, false), last_seen_at = now()
     where session_id = v_sid and user_id = v_uid;
  end if;

  if p_endpoint is not null and char_length(p_endpoint) <= 1000 then
    update public.push_subscriptions
       set device_id = v_dev
     where user_id = v_uid and endpoint = p_endpoint and device_id is distinct from v_dev;
    -- 🚨 ブラウザには通知の登録があるのに DB に無い（強制ログアウトで消えた・別の人が使っていた端末など）。
    --    画面が知らないまま「通知オン」と出て1通も届かないので、画面に作り直してもらう（許可は付いたままなので本人には聞かない）
    v_push_missing := not exists (select 1 from public.push_subscriptions where user_id = v_uid and endpoint = p_endpoint);
  end if;
  return jsonb_build_object('push_missing', v_push_missing);
end;
$function$;

-- 自分でログアウトする直前に呼ぶ（p_reason：'logout'＝自分で／'idle_logout'＝共有パソコンの自動ログアウト）
create or replace function public.record_logout(p_reason text default 'logout')
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_sid uuid;
  d record;
begin
  if v_uid is null then return; end if;
  begin
    v_sid := nullif(auth.jwt() ->> 'session_id', '')::uuid;
  exception when others then
    v_sid := null;
  end;
  -- 1日の上限（同じ人が何度も呼んでも記録が膨らまないように）
  if (select count(*) from public.login_events
       where user_id = v_uid and event in ('logout', 'idle_logout') and at > now() - interval '1 day') >= 100 then
    return;
  end if;
  select * into d from public.session_devices where session_id = v_sid and user_id = v_uid;
  insert into public.login_events (user_id, event, session_id, device_id, device_kind, device_label, shared_pc)
  values (v_uid, case when p_reason = 'idle_logout' then 'idle_logout' else 'logout' end, v_sid,
          d.device_id, d.device_kind, d.device_label, d.shared_pc);
end;
$function$;

-- 管理者：その人のいまログインしている端末
create or replace function public.admin_user_sessions(p_user_id uuid)
returns table (
  session_id uuid, logged_in_at timestamptz, last_used_at timestamptz, user_agent text,
  device_id text, device_kind text, device_label text, shared_pc boolean, is_current boolean
)
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not is_admin() then
    raise exception '管理者だけが使えます' using errcode = '42501';
  end if;
  return query
  select s.id, s.created_at,
         greatest(s.refreshed_at at time zone 'utc', s.updated_at, s.created_at),
         s.user_agent, sd.device_id, sd.device_kind, sd.device_label, sd.shared_pc,
         (s.id::text = coalesce(auth.jwt() ->> 'session_id', ''))
    from auth.sessions s
    left join public.session_devices sd on sd.session_id = s.id
   where s.user_id = p_user_id
   order by greatest(s.refreshed_at at time zone 'utc', s.updated_at, s.created_at) desc;
end;
$function$;

-- 管理者：その端末を強制ログアウト（その端末の通知の登録も消す）
create or replace function public.admin_force_logout(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_uid uuid;
  d record;
  v_push int := 0;
begin
  if not is_admin() then
    raise exception '管理者だけが使えます' using errcode = '42501';
  end if;
  -- 🚨 いま操作しているこの画面のログインは消させない（自分を締め出さない）
  if p_session_id::text = coalesce(auth.jwt() ->> 'session_id', '') then
    return jsonb_build_object('ok', false, 'reason', 'この画面のログインです。ログアウトは右上のメニューから行ってください');
  end if;
  select s.user_id into v_uid from auth.sessions s where s.id = p_session_id;
  if v_uid is null then
    return jsonb_build_object('ok', false, 'reason', 'すでにログアウトしています');
  end if;
  select * into d from public.session_devices where session_id = p_session_id;
  -- 🚨 同じ人・同じ端末で、ほかにまだ使っているログインがあれば通知の登録は消さない（いま使っている方の通知まで止めない）
  if d.device_id is not null and not exists (
       select 1 from auth.sessions s2 join public.session_devices sd2 on sd2.session_id = s2.id
        where s2.user_id = v_uid and sd2.device_id = d.device_id and s2.id <> p_session_id) then
    delete from public.push_subscriptions where user_id = v_uid and device_id = d.device_id;
    get diagnostics v_push = row_count;
  end if;
  delete from auth.sessions where id = p_session_id;
  insert into public.login_events (user_id, event, session_id, device_id, device_kind, device_label, shared_pc, actor_id)
  values (v_uid, 'forced_logout', p_session_id, d.device_id, d.device_kind, d.device_label, d.shared_pc, auth.uid());
  return jsonb_build_object('ok', true, 'push_removed', v_push, 'device_known', d.device_id is not null);
end;
$function$;

-- 使っていないパソコンのログイン（夜の処理と、管理画面の「今夜ログアウトされる見込み」が同じものを見る）
create or replace function public.pc_idle_session_targets(p_days int)
returns table (id uuid, user_id uuid, device_id text, device_kind text, device_label text, shared_pc boolean)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select s.id, s.user_id, sd.device_id, sd.device_kind, sd.device_label, sd.shared_pc
    from auth.sessions s
    left join public.session_devices sd on sd.session_id = s.id
   where p_days > 0
     and greatest(s.refreshed_at at time zone 'utc', s.updated_at, s.created_at) < now() - make_interval(days => p_days)
     and (
       sd.device_kind = 'pc'
       -- 端末が分からないログイン（記録を始める前からで、それ以来開いていないもの）は Windows のパソコンだけ。
       -- 🚨 Mac は含めない：いまの iPad の Safari は Mac と名乗るので、タブレットを消してしまう
       or (sd.session_id is null
           and coalesce(s.user_agent, '') ~ 'Windows NT'
           and coalesce(s.user_agent, '') !~ '(Mobile|Android|Windows Phone)')
     );
$function$;

-- 管理者：日数を変えたら今夜ログアウトされる見込みの台数
create or replace function public.admin_pc_idle_preview(p_days int)
returns integer
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
begin
  if not is_admin() then
    raise exception '管理者だけが使えます' using errcode = '42501';
  end if;
  return (select count(*)::int from public.pc_idle_session_targets(p_days));
end;
$function$;

-- 毎晩：パソコンの長期未使用のログインを消す／古い記録の掃除
create or replace function public.purge_idle_pc_sessions()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_days int;
  v_n int := 0;
begin
  select case when jsonb_typeof(value) = 'number' then round((value)::text::numeric)::int else null end
    into v_days from public.app_settings where key = 'pc_idle_session_days';
  v_days := coalesce(v_days, 30);
  if v_days > 0 then
    with t as (
      select * from public.pc_idle_session_targets(v_days)
    ), ev as (
      insert into public.login_events (user_id, event, session_id, device_id, device_kind, device_label, shared_pc)
      select user_id, 'expired_logout', id, device_id, coalesce(device_kind, 'pc'), device_label, shared_pc from t
      returning session_id
    )
    delete from auth.sessions s using ev where s.id = ev.session_id;
    get diagnostics v_n = row_count;
  end if;
  delete from public.login_events where at < now() - interval '90 days';
  delete from public.session_devices sd
   where not exists (select 1 from auth.sessions s where s.id = sd.session_id)
     and sd.last_seen_at < now() - interval '1 day';
  return v_n;
end;
$function$;

-- 🚨 Supabase は新しい関数に anon の実行権限を付けるので、明示的に外す
revoke execute on function public.record_session_device(text, text, text, boolean, text) from public, anon;
revoke execute on function public.record_logout(text) from public, anon;
revoke execute on function public.admin_user_sessions(uuid) from public, anon;
revoke execute on function public.admin_force_logout(uuid) from public, anon;
revoke execute on function public.purge_idle_pc_sessions() from public, anon, authenticated;
revoke execute on function public.pc_idle_session_targets(int) from public, anon, authenticated;
revoke execute on function public.admin_pc_idle_preview(int) from public, anon;
grant execute on function public.record_session_device(text, text, text, boolean, text) to authenticated, retiree;
grant execute on function public.record_logout(text) to authenticated, retiree;
grant execute on function public.admin_pc_idle_preview(int) to authenticated;
grant execute on function public.admin_user_sessions(uuid) to authenticated;
grant execute on function public.admin_force_logout(uuid) to authenticated;

-- 毎晩 3:40 JST
select cron.unschedule(jobid) from cron.job where jobname = 'purge-idle-pc-sessions';
select cron.schedule('purge-idle-pc-sessions', '40 18 * * *', $cron$ select public.purge_idle_pc_sessions(); $cron$);

commit;
