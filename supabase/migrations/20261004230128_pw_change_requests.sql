-- ============================================================
-- 2026-10-04  パスワード変更の依頼：送信予約と送信履歴（既読・変更したか）
-- ============================================================
-- ✅ ユーザー確定（2026-10-04）
--   ・日時を決めて送れる（15分ごとに確かめて送る）。送る前なら取り消せる
--   ・いつ・誰に・どの理由で送ったかを残す。1人ずつ「ベルを読んだか」「パスワードを変えたか（いつ）」が見られる
--   ・メールを開いたかは分からない（開封は記録していない）。依頼より前に変えていたかも分からない（今日から記録する）
-- ・🚨 この2つの表は画面から直接は読めも書けもしない（RLS 有効・ポリシー無し）。読み書きは Edge Function staff-onboard（管理者だけ）
-- ・🚨 記録を貯めるので掃除を付ける：終わった依頼は1年で消す（毎晩）。1回に送れる人数は在籍者だけ（数十人）なので行数は頭打ち

create table if not exists public.pw_change_requests (
  id            uuid primary key default gen_random_uuid(),
  reason        text not null check (reason in ('initial', 'review')),
  user_ids      uuid[] not null,
  scheduled_for timestamptz,              -- null＝すぐ送った
  sent_at       timestamptz,
  sent_count    integer not null default 0,
  mailed_count  integer not null default 0,
  cancelled_at  timestamptz,
  claimed_at    timestamptz,              -- 送信の取り押さえ（cron が重なっても二重に送らない）
  created_by    uuid references public.profiles(id) on delete set null,
  created_at    timestamptz not null default now()
);
alter table public.pw_change_requests enable row level security;
revoke all on public.pw_change_requests from anon;
revoke all on public.pw_change_requests from authenticated;
comment on table public.pw_change_requests is
  'パスワード変更の依頼（送信予約と送信履歴）。読み書きは staff-onboard だけ。終わったものは1年で消す（2026-10-04）';

create table if not exists public.pw_change_request_recipients (
  request_id      uuid not null references public.pw_change_requests(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  notification_id uuid,                   -- そのとき送ったベル（既読はこの行の read で見る）
  mailed          boolean not null default false,
  primary key (request_id, user_id)
);
alter table public.pw_change_request_recipients enable row level security;
revoke all on public.pw_change_request_recipients from anon;
revoke all on public.pw_change_request_recipients from authenticated;
comment on table public.pw_change_request_recipients is
  'パスワード変更の依頼を実際に送った相手（1人1行）。ベルの id とメールを送れたか（2026-10-04）';

-- パスワードを変えた日時（今日から記録）
alter table public.profiles add column if not exists pw_changed_at timestamptz;
comment on column public.profiles.pw_changed_at is
  'パスワードを最後に変えた日時（変更・再設定の画面が clear_my_password_flag を呼んだとき）。2026-10-04 から記録';

-- 本人がパスワードを変えたら：印を消し、変えた日時を残す（20261004155931 の版から起こした）
create or replace function public.clear_my_password_flag()
 returns void
 language sql
 security definer
 set search_path to 'public'
as $function$
  update public.profiles
     set must_change_password = false,
         pw_changed_at = now()
   where id = auth.uid();
$function$;
revoke execute on function public.clear_my_password_flag() from public;
revoke execute on function public.clear_my_password_flag() from anon;
grant execute on function public.clear_my_password_flag() to authenticated;

-- 送信予約：15分ごと。🚨 送るものがあるときだけ関数を呼ぶ
select cron.unschedule('pw-request-due') where exists (select 1 from cron.job where jobname = 'pw-request-due');
select cron.schedule(
  'pw-request-due',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://xaeynaxctiiyqxjyuzfi.supabase.co/functions/v1/staff-onboard',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := jsonb_build_object('action', 'send_due_pw')
  ) as request_id
  where exists (
    select 1 from public.pw_change_requests
     where scheduled_for is not null and scheduled_for <= now()
       and sent_at is null and cancelled_at is null
  );
  $$
);

-- 掃除：終わった依頼（送った・取り消した）は1年で消す（相手の行は cascade で消える）
select cron.unschedule('purge-pw-change-requests') where exists (select 1 from cron.job where jobname = 'purge-pw-change-requests');
select cron.schedule('purge-pw-change-requests', '25 18 * * *',
  $$delete from public.pw_change_requests where coalesce(sent_at, cancelled_at) < now() - interval '1 year';$$);
