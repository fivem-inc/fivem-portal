-- ============================================================
-- 2026-10-19  休職（段3の1：データベースの土台）
-- 計画と決まったこと：docs/計画-休職と手続き.md（「段3の1の2回目のレビュー」まで）／ 仕分け：docs/計画-休職-段0-仕分け.md
-- ============================================================
-- 作るもの
--   ・表 staff_leaves：休職1回ごとに1行（休職の初日・復職日（戻って最初に出勤する日・空＝未定）・連絡板とスマホのお知らせの希望・使える機能の足し引き）
--     状態は日付と列から決める：取消＝cancelled_at あり／終了＝ended_at あり／休職中＝初日 <= 今日 かつ（復職日が空 か 今日より後）／予定＝初日 > 今日
--     見られるのは本人・マネージャー以上・管理者だけ。書くのは下の関数だけ
--   ・🚨 休職中かどうかは profiles に置かない（profiles は全員が読めるため、だれが休職中か調べられてしまう・2026-10-19 ユーザー確定）。
--     判定は staff_on_leave(uid)（今日）／staff_leave_active_on(uid, 日)。どちらも画面からは呼べない
--   ・画面の申請先の候補から外すための unavailable_approver_ids()：承認者になる役職の人で、いま休職中の人の id だけ
--     （マネージャー以上・管理者が呼ぶと休職中の全員）。一般・パートの休職はほかのスタッフに分からない
--   ・管理者の関数：staff_leave_register／staff_leave_update／staff_leave_cancel（始まる前だけ）／staff_leave_return（今日から復職）
--   ・宛先の関数 profile_ids_for_roles／resolve_role_recipients から休職中の人を外す（本番の実定義から1行ずつ足しただけ）
--   ・権限の関数 is_manager_plus／is_leader_plus／is_leader／is_approver／is_board_approver／is_org_wide は休職中なら false
--     🚨 role_is_*(uid) 本体は変えない
--   ・自分の休職前の日の残業の確定（自己受理）は休職中でもできる（ユーザー確定）：is_manager_plus_role()（休職を見ない）を
--     enforce_overtime_self_confirm と overtime_insert_own／overtime_update_own（欠勤の自己受理）で使う（本番の実定義からその1か所だけ）
--   ・申請先（休暇の1人目・2人目、残業・勤務変更の確認者）に休職中の人を新しく入れるのを止めるトリガー
--     （本人が自分を申請先にする記録＝打刻ズレ・打刻の確認への答え・自己受理は止めない。今ある行・ほかの列だけの更新は止めない）
--   ・毎晩 0:00 JST：復職日が来た行・退職した人の行を閉じる（leave_sync）。退職が確定したときもその場で閉じる
-- 🚨 いま休職中の人はいないので、適用しても誰の動きも変わらない。
-- 🚨 画面と残りの DB（他人の受理を断る・宛先の残り・ベル）がそろうまで、だれも休職に登録しない
--
-- ロールバック手順（逆順）:
--   select cron.unschedule('staff-leave-daily');
--   drop trigger if exists trg_approver_not_on_leave_leave on leave_requests;
--   drop trigger if exists trg_approver_not_on_leave_overtime on overtime_reports;
--   drop trigger if exists trg_approver_not_on_leave_shift on shift_reports;
--   drop trigger if exists trg_profiles_leave_on_retire on profiles;
--   is_* の6本・profile_ids_for_roles・resolve_role_recipients・enforce_overtime_self_confirm と overtime_insert_own／overtime_update_own を
--     下の各定義から「休職」の行を外した形（＝この migration の前の本番の定義。各所のコメントに元の式を書いた）に戻す
--   drop function approver_not_on_leave_guard(), profiles_leave_on_retire(), unavailable_approver_ids(), staff_leave_register(uuid,date,date,text[],text[]),
--     staff_leave_update(uuid,date,date,text[],text[]), staff_leave_cancel(uuid), staff_leave_return(uuid), leave_sync(uuid),
--     staff_on_leave(uuid), staff_leave_active_on(uuid,date), is_manager_plus_role();
--   drop table staff_leaves;

-- ── 1. 表 ─────────────────────────────────────────────
create table if not exists public.staff_leaves (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  start_date       date not null,                -- 休職の初日
  return_date      date,                         -- 復職日（戻って最初に出勤する日）。空＝未定
  board_opt_in     boolean not null default false, -- 連絡板のお知らせ（全員あて・正社員あてなど）を受け取るか
  board_asked_at   timestamptz,                  -- 本人に確認した日時（空＝まだ聞いていない）
  push_on          boolean not null default false, -- スマホのお知らせを受け取るか（段4で使う）
  push_asked_at    timestamptz,
  features_add     text[] not null default '{}', -- この人だけ足す機能（feature_key）
  features_remove  text[] not null default '{}', -- この人だけ引く機能
  created_by       uuid references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_by       uuid references public.profiles(id) on delete set null,
  updated_at       timestamptz not null default now(),
  ended_at         timestamptz,                  -- 終わった日時（今日から復職・復職日の到来・退職）
  ended_by         uuid references public.profiles(id) on delete set null,
  end_reason       text check (end_reason in ('returned', 'scheduled', 'retired')),
  cancelled_at     timestamptz,                  -- 取り消した（始まる前だけ。はじめから無かったことにする）
  cancelled_by     uuid references public.profiles(id) on delete set null,
  constraint staff_leaves_dates check (return_date is null or return_date > start_date)
);
comment on table public.staff_leaves is '休職（1回ごとに1行）。状態は日付と ended_at／cancelled_at から決める。書き込みは staff_leave_* の関数だけ。休職中かは profiles に置かない（全員が読めるため）（2026-10-19）';

-- 同じ人に終わっていない休職は1行まで
create unique index if not exists staff_leaves_one_open
  on public.staff_leaves (user_id) where ended_at is null and cancelled_at is null;
create index if not exists staff_leaves_user on public.staff_leaves (user_id, start_date desc);

alter table public.staff_leaves enable row level security;
revoke all on public.staff_leaves from anon;
revoke insert, update, delete, truncate on public.staff_leaves from authenticated;
drop policy if exists staff_leaves_select on public.staff_leaves;
create policy staff_leaves_select on public.staff_leaves
  for select to authenticated
  using (user_id = auth.uid() or is_manager_plus());

-- ── 2. 判定 ─────────────────────────────────────────────
-- その日に休職中か（シフト表・締め日のお知らせなどで日付を変えて聞くため）
create or replace function public.staff_leave_active_on(p_user uuid, p_day date)
returns boolean
language sql stable security definer set search_path to 'public'
as $$
  select exists (
    select 1 from staff_leaves l
     where l.user_id = p_user and l.cancelled_at is null
       and l.start_date <= p_day
       and (l.return_date is null or l.return_date > p_day)
       and (l.ended_at is null or (l.ended_at at time zone 'Asia/Tokyo')::date > p_day)
  );
$$;

-- 今日休職中か（宛先・申請先・権限の判定はこれだけを見る）
create or replace function public.staff_on_leave(p_user uuid)
returns boolean
language sql stable security definer set search_path to 'public'
as $$ select staff_leave_active_on(p_user, (now() at time zone 'Asia/Tokyo')::date); $$;

-- 画面の申請先の候補から外すための id。承認者になる役職の人で、いま休職中の人だけ
-- （マネージャー以上・管理者には休職中の全員＝その人たちは休職の記録も読めるため）
create or replace function public.unavailable_approver_ids()
returns setof uuid
language sql stable security definer set search_path to 'public'
as $$
  select l.user_id
    from staff_leaves l
    join profiles p on p.id = l.user_id
    left join roles r on r.id = p.role_id
   where staff_on_leave(l.user_id)
     and l.ended_at is null and l.cancelled_at is null
     and (is_manager_plus()
          or coalesce(r.is_approver or r.is_leader_plus or r.is_manager_plus or r.is_board_approver, false));
$$;

-- マネージャー以上の役職か（休職を見ない）。自分の休職前の日の残業の確定（自己受理）だけに使う
create or replace function public.is_manager_plus_role()
returns boolean
language sql stable security definer set search_path to 'public'
as $$
  select is_admin() or exists (select 1 from profiles p where p.id = auth.uid() and p.is_active = true and role_is_manager_plus(p.id));
$$;

-- ── 3. 閉じる（毎晩・退職のとき）─────────────────────────────
-- 復職日が来た行・退職した人の行を閉じる。p_user が空なら全員
create or replace function public.leave_sync(p_user uuid default null)
returns integer
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_n integer := 0;
  v_c integer;
begin
  update staff_leaves l
     set ended_at = now(), end_reason = 'scheduled'
   where l.ended_at is null and l.cancelled_at is null
     and l.return_date is not null and l.return_date <= v_today
     and (p_user is null or l.user_id = p_user);
  get diagnostics v_c = row_count; v_n := v_n + v_c;

  update staff_leaves l
     set ended_at = now(), end_reason = 'retired'
    from profiles p
   where p.id = l.user_id and p.is_active = false
     and l.ended_at is null and l.cancelled_at is null
     and (p_user is null or l.user_id = p_user);
  get diagnostics v_c = row_count; v_n := v_n + v_c;
  return v_n;
end;
$$;

-- 退職が確定したら（is_active が false になったら）休職を閉じる（retire_apply は変えない）
create or replace function public.profiles_leave_on_retire()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
begin
  if old.is_active and not new.is_active then
    perform leave_sync(new.id);
  end if;
  return null;
end;
$$;
drop trigger if exists trg_profiles_leave_on_retire on public.profiles;
create trigger trg_profiles_leave_on_retire
  after update of is_active on public.profiles
  for each row execute function public.profiles_leave_on_retire();

-- ── 4. 管理者の関数 ─────────────────────────────────────
create or replace function public.staff_leave_register(
  p_user uuid, p_start date, p_return date default null,
  p_features_add text[] default '{}', p_features_remove text[] default '{}')
returns uuid
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_id uuid;
begin
  if not is_admin() then raise exception '管理者だけが操作できます' using errcode = '42501'; end if;
  if p_start is null then raise exception '休職の初日を入れてください'; end if;
  if p_return is not null and p_return <= p_start then raise exception '復職日は休職の初日より後にしてください'; end if;
  if p_user = auth.uid() then raise exception '自分自身は休職にできません'; end if;
  if not exists (select 1 from profiles where id = p_user and is_active and coalesce(approval_status, '') <> 'pending') then
    raise exception '在籍中の方だけ休職にできます';
  end if;
  if exists (select 1 from profiles where id = p_user and retire_date is not null) then
    raise exception '退職日が入っている方は、休職を登録できません';
  end if;
  -- 🚨 管理者のアカウントは休職にしない（画面の権限の判定で管理者はすべて通るため、休職の絞り込みが効かない）
  if exists (select 1 from auth.users u where u.id = p_user and (u.raw_app_meta_data ->> 'role') = 'admin') then
    raise exception '管理者のアカウントは休職にできません';
  end if;
  -- 復職日を過ぎて閉じていない行があれば先に閉じる
  perform leave_sync(p_user);
  begin
    insert into staff_leaves (user_id, start_date, return_date, features_add, features_remove, created_by, updated_by)
    values (p_user, p_start, p_return, coalesce(p_features_add, '{}'), coalesce(p_features_remove, '{}'), auth.uid(), auth.uid())
    returning id into v_id;
  exception when unique_violation then
    raise exception 'この方には、すでに登録中の休職があります。［休職を修正］から直してください。';
  end;
  return v_id;
end;
$$;

create or replace function public.staff_leave_update(
  p_id uuid, p_start date, p_return date default null,
  p_features_add text[] default '{}', p_features_remove text[] default '{}')
returns void
language plpgsql security definer set search_path to 'public'
as $$
begin
  if not is_admin() then raise exception '管理者だけが操作できます' using errcode = '42501'; end if;
  if p_start is null then raise exception '休職の初日を入れてください'; end if;
  if p_return is not null and p_return <= p_start then raise exception '復職日は休職の初日より後にしてください'; end if;
  update staff_leaves
     set start_date = p_start, return_date = p_return,
         features_add = coalesce(p_features_add, '{}'), features_remove = coalesce(p_features_remove, '{}'),
         updated_by = auth.uid(), updated_at = now()
   where id = p_id and ended_at is null and cancelled_at is null;
  if not found then raise exception '終わった・取り消した休職は直せません'; end if;
end;
$$;

-- 取り消し：始まる前（予定）だけ。始まった休職は staff_leave_return で終える（期間の記録を残すため・ユーザー確定）
create or replace function public.staff_leave_cancel(p_id uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $$
begin
  if not is_admin() then raise exception '管理者だけが操作できます' using errcode = '42501'; end if;
  update staff_leaves
     set cancelled_at = now(), cancelled_by = auth.uid(), updated_by = auth.uid(), updated_at = now()
   where id = p_id and ended_at is null and cancelled_at is null
     and start_date > (now() at time zone 'Asia/Tokyo')::date;
  if not found then raise exception '取り消せるのは、始まる前の休職だけです（始まった休職は［今日から復職にする］）'; end if;
end;
$$;

-- 今日から復職（復職日より早く戻るときも・未定のときも）
create or replace function public.staff_leave_return(p_id uuid)
returns void
language plpgsql security definer set search_path to 'public'
as $$
begin
  if not is_admin() then raise exception '管理者だけが操作できます' using errcode = '42501'; end if;
  update staff_leaves
     set ended_at = now(), ended_by = auth.uid(), end_reason = 'returned', updated_by = auth.uid(), updated_at = now()
   where id = p_id and ended_at is null and cancelled_at is null
     and start_date <= (now() at time zone 'Asia/Tokyo')::date;
  if not found then raise exception '休職中の方だけ復職にできます（始まる前の休職は［取り消す］）'; end if;
end;
$$;

-- ── 5. 宛先の関数（本番の実定義に「休職中を外す」を1行ずつ足しただけ）────────────
CREATE OR REPLACE FUNCTION public.profile_ids_for_roles(p_spec text[], p_exclude uuid DEFAULT NULL::uuid)
 RETURNS SETOF uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p.id from profiles p
   where p.is_active = true
     and not staff_on_leave(p.id)   -- 休職中は宛先から外す（2026-10-19）
     and p.role_id = any(role_ids_for(p_spec))
     and (p_exclude is null or p.id <> p_exclude);
$function$;

CREATE OR REPLACE FUNCTION public.resolve_role_recipients(p_applicant uuid, p_recipient jsonb)
 RETURNS SETOF uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_roles_raw    text[];
  v_owide_raw    text[];
  v_roles        uuid[];
  v_org_wide     uuid[];
  v_group_roles  uuid[];
  v_owide_roles  uuid[];
  v_group_filter text;
  v_teams        text[];
begin
  v_group_filter := coalesce(p_recipient ->> 'groupFilter', 'all');

  -- 宛先の役職。指定が無ければ立場 leader/manager/president の役職すべて
  if p_recipient ? 'roles' then
    v_roles_raw := coalesce((select array_agg(x) from jsonb_array_elements_text(p_recipient -> 'roles') x), '{}');
    v_roles := role_ids_for(v_roles_raw);
  else
    v_roles := role_ids_for(array['leader', 'manager', 'president']);
  end if;

  -- 絞り込みの対象外。指定が無ければ属性「経営」の役職すべて
  if p_recipient ? 'orgWideRoles' then
    v_owide_raw := coalesce((select array_agg(x) from jsonb_array_elements_text(p_recipient -> 'orgWideRoles') x), '{}');
    v_org_wide := role_ids_for(v_owide_raw);
  else
    v_org_wide := role_ids_for(array['org_wide']);
  end if;

  v_group_roles := array(select unnest(v_roles) except select unnest(v_org_wide));
  v_owide_roles := array(select unnest(v_roles) intersect select unnest(v_org_wide));

  select coalesce(array_agg(g), '{}')
    into v_teams
    from unnest(coalesce((select group_names from profiles where id = p_applicant), '{}')) g
   where g in (select value from master_options where category = 'shift_report_group');

  if not exists (select 1 from master_options where category = 'shift_report_group') then
    v_teams := coalesce((select group_names from profiles where id = p_applicant), '{}');
  end if;

  return query
    select p.id from profiles p
     where p.is_active = true
       and not staff_on_leave(p.id)   -- 休職中は宛先から外す（2026-10-19）
       and p.role_id = any(v_group_roles)
       and (v_group_filter <> 'same' or cardinality(v_teams) = 0 or p.group_names && v_teams)
       and p.id <> p_applicant
    union
    select p.id from profiles p
     where p.is_active = true
       and not staff_on_leave(p.id)   -- 休職中は宛先から外す（2026-10-19）
       and p.role_id = any(v_owide_roles)
       and p.id <> p_applicant;
end $function$;

-- ── 6. 権限の関数（auth.uid() 版だけ。休職中は役職としての操作をさせない）──────────
-- 元の本番の定義（ロールバック用）：
--   is_manager_plus   = select is_admin() or exists (select 1 from profiles p where p.id = auth.uid() and p.is_active = true and role_is_manager_plus(p.id));
--   is_leader         = select exists (select 1 from profiles p where p.id = auth.uid() and p.is_active = true and role_acts_as(p.id) = 'leader');
--   is_leader_plus    = select role_is_leader_plus(auth.uid());
--   is_approver       = select role_is_approver(auth.uid());
--   is_board_approver = select role_is_board_approver(auth.uid());
--   is_org_wide       = select role_is_org_wide(auth.uid());
CREATE OR REPLACE FUNCTION public.is_manager_plus()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select is_admin() or exists (select 1 from profiles p where p.id = auth.uid() and p.is_active = true and role_is_manager_plus(p.id) and not staff_on_leave(p.id));
$function$;

CREATE OR REPLACE FUNCTION public.is_leader()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from profiles p where p.id = auth.uid() and p.is_active = true and role_acts_as(p.id) = 'leader' and not staff_on_leave(p.id));
$function$;

CREATE OR REPLACE FUNCTION public.is_leader_plus()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ select role_is_leader_plus(auth.uid()) and not staff_on_leave(auth.uid()); $function$;

CREATE OR REPLACE FUNCTION public.is_approver()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ select role_is_approver(auth.uid()) and not staff_on_leave(auth.uid()); $function$;

CREATE OR REPLACE FUNCTION public.is_board_approver()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ select role_is_board_approver(auth.uid()) and not staff_on_leave(auth.uid()); $function$;

CREATE OR REPLACE FUNCTION public.is_org_wide()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ select role_is_org_wide(auth.uid()) and not staff_on_leave(auth.uid()); $function$;

-- ── 7. 自分の休職前の日の残業の確定（自己受理）は休職中でもできる（本番の実定義から1か所ずつ）──────
-- 元：if is_manager_plus() then return new; end if;
CREATE OR REPLACE FUNCTION public.enforce_overtime_self_confirm()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- サーバー（cron・Edge Function・service_role）
  if auth.uid() is null then return new; end if;
  -- 予定どおりの実績報告（overtime_confirm_as_planned の中だけ立つ印・2026-10-13）
  if coalesce(current_setting('app.ot_as_planned', true), '') = 'on' then return new; end if;
  -- シフト表どおりの出張（overtime_confirm_trip_rostered の中だけ立つ印・2026-10-14）
  if coalesce(current_setting('app.ot_trip_rostered', true), '') = 'on' then return new; end if;
  -- 本人以外（上長・管理者が他人の申請を受理する）
  if new.applicant_id is distinct from auth.uid() then return new; end if;
  -- 自動計上（休暇由来など）は対象外
  if new.entry_type is distinct from 'manual' then return new; end if;
  -- 確定・事前受理に「する」ときだけ見る
  if new.status not in ('confirmed', 'request_confirmed') then return new; end if;
  if tg_op = 'UPDATE' and old.status = new.status then return new; end if;
  -- マネージャー以上（管理者を含む）は自己受理できる。休職中でも自分の分はできる（2026-10-19・is_manager_plus_role は休職を見ない）
  if is_manager_plus_role() then return new; end if;
  -- だれでも自分で確定できるもの：「残業なし」の実績報告／「打刻ズレ」（どちらも差分0）
  if new.status = 'confirmed' and coalesce(new.diff_minutes, 0) = 0
     and (coalesce(cardinality(new.application_types), 0) = 0 or new.application_types = array['clock_only']::text[]) then
    return new;
  end if;
  raise exception '自分で受理（自己受理）できるのはマネージャー以上です。申請先を選んで送ってください'
    using errcode = '42501';
end;
$function$;

-- 元：… OR is_manager_plus()))   （欠勤の自己受理）
drop policy if exists overtime_insert_own on public.overtime_reports;
create policy overtime_insert_own on public.overtime_reports
  for insert to authenticated
  with check ((submitted_by = auth.uid()) AND (applicant_id = auth.uid()) AND (entry_type = 'manual'::text)
    AND ((NOT ('absence'::text = ANY (application_types))) OR (confirmed_by IS DISTINCT FROM auth.uid()) OR is_manager_plus_role()));

drop policy if exists overtime_update_own on public.overtime_reports;
create policy overtime_update_own on public.overtime_reports
  for update to authenticated
  using ((applicant_id = auth.uid()) AND (entry_type = 'manual'::text) AND (status = ANY (ARRAY['requested'::text, 'request_confirmed'::text, 'reported'::text, 'returned'::text])))
  with check ((applicant_id = auth.uid()) AND (entry_type = 'manual'::text)
    AND ((status = ANY (ARRAY['requested'::text, 'request_confirmed'::text, 'reported'::text, 'returned'::text]))
         OR ((status = 'confirmed'::text) AND (confirmed_by = auth.uid()) AND ((NOT ('absence'::text = ANY (application_types))) OR is_manager_plus_role()))));

-- ── 8. 申請先に休職中の人を新しく入れない ─────────────────────
create or replace function public.approver_not_on_leave_guard()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_ids uuid[] := array[]::uuid[];
  v_id uuid;
begin
  if TG_TABLE_NAME = 'leave_requests' then
    if TG_OP = 'INSERT' or new.approver_id is distinct from old.approver_id then v_ids := v_ids || new.approver_id; end if;
    if TG_OP = 'INSERT' or new.approver2_id is distinct from old.approver2_id then v_ids := v_ids || new.approver2_id; end if;
  else
    if TG_OP = 'INSERT' or new.reviewer_id is distinct from old.reviewer_id then
      -- 本人が自分を申請先にする記録（打刻ズレ・打刻の確認への答え・自己受理）は止めない
      if new.reviewer_id is distinct from new.applicant_id then v_ids := v_ids || new.reviewer_id; end if;
    end if;
  end if;
  foreach v_id in array v_ids loop
    if v_id is not null and staff_on_leave(v_id) then
      raise exception 'APPROVER_ON_LEAVE|この方は現在、申請先に選べません。別の方を選んでください。';
    end if;
  end loop;
  return new;
end;
$$;
drop trigger if exists trg_approver_not_on_leave_leave on public.leave_requests;
create trigger trg_approver_not_on_leave_leave
  before insert or update of approver_id, approver2_id on public.leave_requests
  for each row execute function public.approver_not_on_leave_guard();
drop trigger if exists trg_approver_not_on_leave_overtime on public.overtime_reports;
create trigger trg_approver_not_on_leave_overtime
  before insert or update of reviewer_id on public.overtime_reports
  for each row execute function public.approver_not_on_leave_guard();
drop trigger if exists trg_approver_not_on_leave_shift on public.shift_reports;
create trigger trg_approver_not_on_leave_shift
  before insert or update of reviewer_id on public.shift_reports
  for each row execute function public.approver_not_on_leave_guard();

-- ── 9. 毎晩 0:00 JST に閉じる ──────────────────────────
select cron.unschedule('staff-leave-daily') where exists (select 1 from cron.job where jobname = 'staff-leave-daily');
select cron.schedule('staff-leave-daily', '0 15 * * *', $$select public.leave_sync(null)$$);

-- ── 10. 実行の権限 ─────────────────────────────────────
revoke execute on function public.leave_sync(uuid) from public, anon, authenticated;
revoke execute on function public.profiles_leave_on_retire() from public, anon, authenticated;
revoke execute on function public.approver_not_on_leave_guard() from public, anon, authenticated;
revoke execute on function public.staff_leave_active_on(uuid, date) from public, anon, authenticated;
revoke execute on function public.staff_on_leave(uuid) from public, anon, authenticated;
revoke execute on function public.is_manager_plus_role() from public, anon;
revoke execute on function public.unavailable_approver_ids() from public, anon;
revoke execute on function public.staff_leave_register(uuid, date, date, text[], text[]) from public, anon;
revoke execute on function public.staff_leave_update(uuid, date, date, text[], text[]) from public, anon;
revoke execute on function public.staff_leave_cancel(uuid) from public, anon;
revoke execute on function public.staff_leave_return(uuid) from public, anon;
grant execute on function public.is_manager_plus_role() to authenticated;
grant execute on function public.unavailable_approver_ids() to authenticated;
grant execute on function public.staff_leave_register(uuid, date, date, text[], text[]) to authenticated;
grant execute on function public.staff_leave_update(uuid, date, date, text[], text[]) to authenticated;
grant execute on function public.staff_leave_cancel(uuid) to authenticated;
grant execute on function public.staff_leave_return(uuid) to authenticated;
