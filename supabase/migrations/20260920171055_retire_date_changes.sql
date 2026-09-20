-- 退職日・期限を後から直せるようにし、変更の記録を残す（2026-09-20 ユーザー依頼・実機の指摘）
--
-- 【なぜ要るか（本番で確認）】
--  ・退職済みの人にできるのは［復活］と［削除］だけで、**退職日も期限も直す手段が無かった**。
--    `retire_schedule` は「在籍中の人だけ」と断る作り。
--  ・いちばん困るのは**期限**。差し戻しが期限ぎりぎりに来ても延ばせず、
--    「復活 → もう一度退職」しか道が無い（＝確認者の付け替えがもう一度走ってしまう）。
--  ・退職日の打ち間違い・後からの変更も実際に起きている（ユーザー談）。
--
-- 【決まったこと（2026-09-20 ユーザー確定）】
--  ・**退職日と期限の両方を直せる**（案B）。🚨 ただし直しても**在籍には戻さない**（戻すのは［復活］だけ）
--  ・**変更のたびに1行残す**（案2）。何から何へ・誰が・いつ
--  ・🚨 記録を貯めるので**掃除もセット**で入れる（退職は年に数件なので、増え方は年10行ほど）

-- ───────────────────────────────────────────────
-- 1. 変更の記録
-- ───────────────────────────────────────────────
create table if not exists public.retire_date_changes (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  old_retire_date  date,
  new_retire_date  date,
  old_access_until date,
  new_access_until date,
  changed_by       uuid references public.profiles(id) on delete set null,
  changed_at       timestamptz not null default now()
);
comment on table public.retire_date_changes is
  '退職日・ログインできる期限の変更の記録（2026-09-20）。最初の登録も1行目として残す。🚨 掃除は purge-retire-date-changes';
create index if not exists idx_retire_date_changes_user on public.retire_date_changes (user_id, changed_at desc);

alter table public.retire_date_changes enable row level security;
-- 読めるのは管理者とマネージャー以上（退職の手続きの画面と同じ範囲）
drop policy if exists retire_date_changes_select on public.retire_date_changes;
create policy retire_date_changes_select on public.retire_date_changes
  for select to authenticated
  using (is_admin() or is_manager_plus());
-- 書き込みは RPC（security definer）からだけ。画面から直接は書かせない

-- ───────────────────────────────────────────────
-- 2. 記録を残す共通の処理（🚨 同じ insert を2か所に書かない）
-- ───────────────────────────────────────────────
create or replace function public.retire_log_date_change(
  p_user uuid, p_old_date date, p_new_date date, p_old_until date, p_new_until date
) returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $fn$
begin
  -- 何も変わっていないなら残さない（押しただけの行を増やさない）
  if p_old_date is not distinct from p_new_date and p_old_until is not distinct from p_new_until then
    return;
  end if;
  insert into public.retire_date_changes
    (user_id, old_retire_date, new_retire_date, old_access_until, new_access_until, changed_by)
  values (p_user, p_old_date, p_new_date, p_old_until, p_new_until, auth.uid());
end;
$fn$;
revoke execute on function public.retire_log_date_change(uuid, date, date, date, date) from public, anon, authenticated;

-- ───────────────────────────────────────────────
-- 3. 退職日を入れる（既存）に、記録を残す処理を足す
--    🚨 本番の実定義から起こした。足したのは「前の値を控える」1行と「記録を残す」1行だけ
-- ───────────────────────────────────────────────
create or replace function public.retire_schedule(p_user uuid, p_retire_date date, p_access_until date default null::date)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_until date;
  v_moved integer := 0;
  v_applied boolean := false;
  v_old_date date;
  v_old_until date;
begin
  if not is_admin() then raise exception '管理者だけが操作できます' using errcode = '42501'; end if;
  if p_retire_date is null then raise exception '退職日を入れてください'; end if;
  if p_user = auth.uid() then raise exception '自分自身は退職にできません'; end if;

  v_until := coalesce(p_access_until, retire_access_default(p_retire_date));
  if v_until < p_retire_date then raise exception '申請の期限は退職日より後にしてください'; end if;

  -- 変更の記録に「何から」を残すため、先に控える（2026-09-20）
  select retire_date, retiree_access_until into v_old_date, v_old_until from profiles where id = p_user;

  update profiles
     set retire_date = p_retire_date,
         retiree_access_until = v_until
   where id = p_user
     and is_active = true
     and coalesce(approval_status, '') <> 'pending';
  if not found then
    raise exception '在籍中の人だけ退職日を入れられます（承認待ち・退職済みの人は対象外）';
  end if;

  perform retire_log_date_change(p_user, v_old_date, p_retire_date, v_old_until, v_until);

  -- 過去の日（＝すでに在籍の最終日を過ぎている）はその場で切り替える（2026-09-19 確定）
  if p_retire_date < v_today then
    v_moved := retire_apply(p_user);
    v_applied := true;
  end if;

  return jsonb_build_object(
    'retire_date', p_retire_date,
    'access_until', v_until,
    'applied_now', v_applied,
    'access_expired', v_until < v_today,
    'reassigned', v_moved
  );
end;
$function$;

-- ───────────────────────────────────────────────
-- 4. 退職済みの人の退職日・期限を直す（新設）
--    🚨 直しても **在籍には戻さない**（is_active は触らない。戻すのは retire_restore）
--    🚨 退職の切り替えはやり直さない（付け替えを二度走らせない）
-- ───────────────────────────────────────────────
create or replace function public.retire_update_dates(p_user uuid, p_retire_date date, p_access_until date)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  v_old_date date;
  v_old_until date;
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
begin
  if not is_admin() then raise exception '管理者だけが操作できます' using errcode = '42501'; end if;
  if p_retire_date is null then raise exception '退職日を入れてください'; end if;
  if p_access_until is null then raise exception 'ログインできる期限を入れてください'; end if;
  if p_access_until < p_retire_date then raise exception '期限は退職日より後にしてください'; end if;

  select retire_date, retiree_access_until into v_old_date, v_old_until from profiles where id = p_user;
  if v_old_date is null then
    raise exception '退職日が入っている人だけ直せます';
  end if;

  update profiles
     set retire_date = p_retire_date,
         retiree_access_until = p_access_until
   where id = p_user;
  if not found then raise exception '直せませんでした（対象が見つかりません）'; end if;

  perform retire_log_date_change(p_user, v_old_date, p_retire_date, v_old_until, p_access_until);

  return jsonb_build_object(
    'retire_date', p_retire_date,
    'access_until', p_access_until,
    'access_expired', p_access_until < v_today,
    'changed', (v_old_date is distinct from p_retire_date) or (v_old_until is distinct from p_access_until)
  );
end;
$fn$;

-- 🚨 新しい関数は anon から明示的に外す（from public では外れない）
revoke execute on function public.retire_update_dates(uuid, date, date) from public, anon;
grant  execute on function public.retire_update_dates(uuid, date, date) to authenticated, service_role;

-- ───────────────────────────────────────────────
-- 5. 掃除（🚨 記録を貯める仕組みには必ずセットで付ける）
--    退職は年に数件なので増え方は年10行ほど。それでも上限は必ず置く
-- ───────────────────────────────────────────────
select cron.schedule(
  'purge-retire-date-changes',
  '0 19 * * 0',          -- 毎週日曜 4:00 JST
  $cron$
    delete from public.retire_date_changes
     where changed_at < now() - interval '24 months';
    delete from public.retire_date_changes
     where id in (select id from public.retire_date_changes order by changed_at desc offset 10000);
  $cron$
);

-- 戻し版（この migration を取り消すとき）:
--   select cron.unschedule('purge-retire-date-changes');
--   drop function if exists public.retire_update_dates(uuid, date, date);
--   （retire_schedule は 2026-09-19 の版に戻す）
--   drop function if exists public.retire_log_date_change(uuid, date, date, date, date);
--   drop table if exists public.retire_date_changes;
