-- ============================================================
-- 2026-10-04  入社予定スタッフの登録・招待メール・パスワード変更の促し（DB）
-- ============================================================
-- 設計と決めたことは docs/計画-入社予定スタッフの登録と招待.md
-- ・入社予定＝is_active=false かつ hire_date あり かつ retired_at なし かつ approval_status≠'pending'
--   （判定は画面の lib/staffState.ts と、ここの my_access_state だけ）
-- ・🚨 handle_new_user / my_access_state は 2026-10-04 に本番の実定義（pg_get_functiondef）から起こした
-- ・新しい関数は anon から外す（from public だけでは外れない）

-- ── 1. profiles の列 ──────────────────────────────────────────
alter table public.profiles
  add column if not exists hire_date              date,
  add column if not exists invite_scheduled_for   timestamptz,
  add column if not exists invite_sent_at         timestamptz,
  add column if not exists invite_send_count      integer not null default 0,
  add column if not exists invite_claimed_at      timestamptz,
  add column if not exists must_change_password   boolean not null default false,
  add column if not exists pw_change_requested_at timestamptz,
  add column if not exists pw_change_reason       text check (pw_change_reason in ('initial', 'review')),
  add column if not exists setup_mail_last_at     timestamptz,
  add column if not exists setup_mail_day         date,
  add column if not exists setup_mail_count       integer not null default 0;

comment on column public.profiles.hire_date is '入社日。入社予定（is_active=false）の人はこの日の 0:01 に hire_daily が在籍にする。入社後も消さない';
comment on column public.profiles.invite_scheduled_for is '招待メールを送る予定の時刻（入社日の朝10時など）。null＝予定なし。送ると null に戻り invite_sent_at が入る';
comment on column public.profiles.invite_sent_at is '招待メールを最後に送った時刻';
comment on column public.profiles.invite_send_count is '招待メールを送った回数（再送を含む）';
comment on column public.profiles.invite_claimed_at is '招待メールの送信を取り押さえた時刻（二重送信の防止。送り終えたら null に戻す）';
comment on column public.profiles.must_change_password is 'パスワードの変更をお願いしている印。ホームにバナーを出す。本人が変えると clear_my_password_flag で消える';
comment on column public.profiles.pw_change_requested_at is 'パスワード変更の依頼を最後に送った時刻';
comment on column public.profiles.pw_change_reason is 'パスワード変更をお願いする理由（initial=初期パスワードのまま／review=安全のための見直し）。バナー・ベル・メールの文が変わる（2026-10-04 ユーザー確定）';
comment on column public.profiles.setup_mail_last_at is 'パスワード設定のメール（ログイン画面の［はじめての方］）を最後に送った時刻。1分に1回まで';
comment on column public.profiles.setup_mail_day is 'setup_mail_count を数えている日（JST）';
comment on column public.profiles.setup_mail_count is 'その日にパスワード設定のメールを送った回数。1日5回まで';

-- ── 2. handle_new_user（本番の実定義から） ─────────────────────
-- 変えたこと：
--   ・管理者が作ったアカウント（app_metadata の provisioned_by_admin）では、経理への「新規登録」の通知を飛ばさない
--     🚨 印は app_metadata に置く。user_metadata は本人が signUp で自由に書けるので、そこに置くと誰でも通知を止められる
--   ・名前は name が無ければ full_name を見る（create-user は full_name で渡していた）
--   ・SECURITY DEFINER なので search_path を固定する
create or replace function public.handle_new_user()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  insert into public.profiles (id, email, name, is_active, approval_status)
  values (new.id, new.email,
          coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'full_name'),
          false, 'pending');

  if coalesce(new.raw_app_meta_data->>'provisioned_by_admin', '') <> 'true' then
    perform net.http_post(
      url := 'https://xaeynaxctiiyqxjyuzfi.supabase.co/functions/v1/new-signup-notify',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
      ),
      body := jsonb_build_object('email', new.email,
                                 'name', coalesce(new.raw_user_meta_data->>'name', new.raw_user_meta_data->>'full_name'))
    );
  end if;

  return new;
end;
$function$;

-- ── 3. my_access_state（本番の実定義から） ─────────────────────
-- 変えたこと：入社予定の人に mode='prehire'（＋入社日）を返す。画面はそれを見て「◯/◯から使えます」と出す
--   🚨 承認待ちの判定より後・退職者の判定より前に置く（入社予定は retired_at が無いので退職者と取り違えない）
create or replace function public.my_access_state()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  p record;
  v_keys jsonb;
begin
  select pr.id, pr.is_active, pr.approval_status, pr.retire_date, pr.retiree_access_until,
         pr.hire_date, pr.retired_at
    into p
    from public.profiles pr
   where pr.id = auth.uid();

  if not found then
    return jsonb_build_object('mode', 'blocked');
  end if;

  if p.is_active then
    return jsonb_build_object('mode', 'staff');
  end if;

  -- 🚨 承認待ちは退職者より先に判定する（取り違えるとログインさせてしまう）
  if coalesce(p.approval_status, '') = 'pending' then
    return jsonb_build_object('mode', 'blocked');
  end if;

  -- 入社予定（2026-10-04）。ログインはさせない（mode が staff でないので画面が追い出す）。入社日を返すだけ
  if p.hire_date is not null and p.retired_at is null and p.retire_date is null then
    return jsonb_build_object('mode', 'prehire', 'hire_date', p.hire_date);
  end if;

  if public.is_retiree_in_grace(p.id) then
    select coalesce(s.value -> 'keys', '[]'::jsonb) into v_keys
      from public.app_settings s where s.key = 'retiree_feature_keys';
    return jsonb_build_object(
      'mode',         'retiree_grace',
      'access_until', p.retiree_access_until,
      'retire_date',  p.retire_date,
      'feature_keys', coalesce(v_keys, '[]'::jsonb)
    );
  end if;

  return jsonb_build_object('mode', 'blocked');
exception when others then
  -- 🚨 ここで例外を投げると、画面が「立場が分からない」まま止まる。分からないときは blocked に倒す
  return jsonb_build_object('mode', 'blocked');
end;
$function$;

-- ── 4. 入社日に在籍へ切り替える（毎晩 0:01 JST） ──────────────
create or replace function public.hire_daily()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  r record;
  v_count integer := 0;
begin
  for r in
    select id from profiles
     where is_active = false
       and hire_date is not null
       and hire_date <= (now() at time zone 'Asia/Tokyo')::date
       and retired_at is null
       and retire_date is null
       and coalesce(approval_status, '') <> 'pending'
  loop
    -- 🚨 1人ずつ失敗を受け止める（retire_daily と同じ）。失敗した人は入社予定のまま残り、管理画面に「切り替えに失敗」と出る
    begin
      update profiles set is_active = true, approval_status = 'approved' where id = r.id;
      v_count := v_count + 1;
    exception when others then
      raise warning '[hire_daily] % の在籍への切り替えに失敗しました: %', r.id, sqlerrm;
    end;
  end loop;
  return v_count;
end;
$function$;

revoke execute on function public.hire_daily() from public;
revoke execute on function public.hire_daily() from anon;
revoke execute on function public.hire_daily() from authenticated;

comment on function public.hire_daily() is
  '入社日になった入社予定の人を在籍（is_active=true）にする。cron hire-daily（毎日 15:01 UTC＝0:01 JST）が呼ぶ（2026-10-04）';

-- ── 5. 本人がパスワードを変えたあと、変更のお願いの印を消す ─────────
create or replace function public.clear_my_password_flag()
 returns void
 language sql
 security definer
 set search_path to 'public'
as $function$
  update public.profiles
     set must_change_password = false
   where id = auth.uid() and must_change_password;
$function$;

revoke execute on function public.clear_my_password_flag() from public;
revoke execute on function public.clear_my_password_flag() from anon;
grant execute on function public.clear_my_password_flag() to authenticated;

comment on function public.clear_my_password_flag() is
  'パスワードの変更・再設定に成功した直後に画面が呼ぶ。ホームの「パスワードを変更してください」のバナーを消す（2026-10-04）';

-- ── 6. cron ─────────────────────────────────────────────────
-- 入社日の切り替え：退職の retire-daily（15:05 UTC）より前
select cron.unschedule('hire-daily') where exists (select 1 from cron.job where jobname = 'hire-daily');
select cron.schedule('hire-daily', '1 15 * * *', $$select public.hire_daily();$$);

-- 招待メールの送信予定：15分ごと。🚨 送るものがあるときだけ関数を呼ぶ（無いときは何も通信しない）
--   送り終えたら関数が invite_scheduled_for を null に戻す。取り押さえ（invite_claimed_at）と二重送信の防止も関数の中でやる
select cron.unschedule('staff-invite-due') where exists (select 1 from cron.job where jobname = 'staff-invite-due');
select cron.schedule(
  'staff-invite-due',
  '*/15 * * * *',
  $$
  select net.http_post(
    url := 'https://xaeynaxctiiyqxjyuzfi.supabase.co/functions/v1/staff-onboard',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'service_role_key')
    ),
    body := jsonb_build_object('action', 'send_due')
  ) as request_id
  where exists (
    select 1 from public.profiles
     where invite_scheduled_for is not null
       and invite_scheduled_for <= now()
       and email not like '%.invalid'
  );
  $$
);

-- 確認用:
--   select has_function_privilege('anon','public.clear_my_password_flag()','execute');  -- false
--   select has_function_privilege('anon','public.hire_daily()','execute');               -- false
--   select jobname, schedule from cron.job where jobname in ('hire-daily','staff-invite-due');
