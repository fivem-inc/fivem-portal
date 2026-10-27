-- 2026-10-27 段2b：時間外調整休を有休に変更する（計画 docs/計画-言葉をそろえる-休暇の種類の変更.md の「ユーザーの決定」）
--
-- 入口はご本人だけ（残業ページの時間外調整休のカードの［有休に変更する］・2026-10-27 ユーザー確定）。上長からの案内は作らない
-- 流れ：休暇申請（有給休暇・バースデー休暇・その日だけ）をリーダーを飛ばしてマネージャーの受理の段（step2_pending）で出す
--   → 🚨 マネージャーが受理した瞬間（manager_approved＝カレンダーに出る）に、その日の時間外調整休を取り消す（同じ取引）
--   → 経理・社長の受理はいつもどおり。経理か社長が差し戻したら（取り消しても）時間外調整休を元に戻す（確認済みのまま）・ご本人とマネージャーへベル
--   → 締め（支給月の17日）のあとは変えられない・マネージャーの受理も止める（管理者は受理できる）
-- 🚨 本人の insert_own は status='pending' しか入れられないので、登録は専用の関数 create_leave_from_chosei（security definer）だけ
-- 本番の実定義（2026-10-27）から起こした関数：day_off_conflict_message／my_day_off_conflict／enforce_day_off_conflict_leave／
--   reopen_application_request_on_cancel／enforce_appreq_leave_replace（変えた所に 2026-10-27 段2b）

alter table public.leave_requests
  add column if not exists replaces_overtime_id uuid references public.overtime_reports(id) on delete set null;
comment on column public.leave_requests.replaces_overtime_id is
  'この有休がマネージャーに受理されたら取り消す時間外調整休（2026-10-27 段2b）。差し戻し・取消で元に戻す。あとから変えられない';
create index if not exists leave_requests_replaces_overtime_idx on public.leave_requests (replaces_overtime_id) where replaces_overtime_id is not null;

-- 🚨 元に戻すのは「この有休の受理で取り消した時間外調整休」だけ（ほかの理由で取り消したものを戻さない）。取り消したときに印を付け、戻したら消す
alter table public.overtime_reports
  add column if not exists replaced_by_leave_id uuid references public.leave_requests(id) on delete set null;
comment on column public.overtime_reports.replaced_by_leave_id is
  'この時間外調整休を取り消した有休（2026-10-27 段2b）。有休が差し戻し・取消になったら、この印がある時間外調整休だけ元に戻す。書けるのはトリガーだけ';

-- ───────── 給与の締め（支給月の17日）を過ぎた日か。段2a の leave_replace_block と同じ数え方 ─────────
create or replace function public.payroll_close_passed(p_date date)
 returns boolean
 language plpgsql
 stable
 set search_path to 'public'
as $function$
declare
  v_pps date;
begin
  if p_date is null then return false; end if;
  if extract(day from p_date) >= 16 then v_pps := date_trunc('month', p_date)::date + 15;
  else v_pps := (date_trunc('month', p_date) - interval '1 month')::date + 15; end if;
  return (now() at time zone 'Asia/Tokyo')::date > (date_trunc('month', v_pps + interval '1 month'))::date + 16;
end;
$function$;
revoke execute on function public.payroll_close_passed(date) from public;
revoke execute on function public.payroll_close_passed(date) from anon;
revoke execute on function public.payroll_close_passed(date) from authenticated;

-- ───────── 変えられる時間外調整休か（理由の文・変えられるなら null）。1か所 ─────────
create or replace function public.overtime_replace_block(p_ot uuid, p_user uuid, p_check_close boolean)
 returns text
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  o record;
  v_msg text;
begin
  select id, applicant_id, entry_type, status, application_types, work_date into o from overtime_reports where id = p_ot;
  if o.id is null or o.applicant_id is distinct from p_user or o.entry_type is distinct from 'manual' then
    return 'この申請は変えられません';
  end if;
  if o.application_types is distinct from array['chosei_off']::text[] then
    return '有休に変更できるのは、時間外調整休だけです';
  end if;
  if o.status <> 'confirmed' then return '受理されている時間外調整休だけ変更できます'; end if;
  -- 有休奨励日に有休が止まる日（奨励日の回答から）
  if public.encouragement_blocked_kind('leave', '有給休暇', null) then
    v_msg := public.encouragement_block_message(p_user, o.work_date);
    if v_msg is not null then return v_msg; end if;
  end if;
  if p_check_close and public.payroll_close_passed(o.work_date) then
      return '給与計算が始まっているため（毎月17日以降）変えられません。管理者に修正を依頼してください';
  end if;
  return null;
end;
$function$;
revoke execute on function public.overtime_replace_block(uuid, uuid, boolean) from public;
revoke execute on function public.overtime_replace_block(uuid, uuid, boolean) from anon;
revoke execute on function public.overtime_replace_block(uuid, uuid, boolean) from authenticated;

create or replace function public.my_overtime_replace_block(p_ot uuid)
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select case when auth.uid() is null then 'ログインしてください'
              else public.overtime_replace_block(p_ot, auth.uid(), true) end;
$function$;
revoke execute on function public.my_overtime_replace_block(uuid) from public;
revoke execute on function public.my_overtime_replace_block(uuid) from anon;
grant execute on function public.my_overtime_replace_block(uuid) to authenticated;

-- ───────── 登録（ご本人だけ・マネージャーの受理の段から） ─────────
create or replace function public.create_leave_from_chosei(
  p_id uuid, p_ot uuid, p_leave_type text, p_approver uuid, p_purpose text, p_reason text, p_location text)
 returns uuid
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_uid uuid := auth.uid();
  v_msg text;
  v_date date;
begin
  if v_uid is null then raise exception 'LEAVE_CHANGE|ログインしてください' using errcode = '42501'; end if;
  -- 押し直し（同じ番号）は1件のまま（lib/submitOnce）
  if exists (select 1 from leave_requests where id = p_id and user_id = v_uid) then return p_id; end if;
  v_msg := public.overtime_replace_block(p_ot, v_uid, true);
  if v_msg is not null then raise exception 'LEAVE_CHANGE|%', v_msg using errcode = 'check_violation'; end if;
  if p_leave_type not in ('有給休暇', 'バースデー休暇（有給）') then
    raise exception 'LEAVE_CHANGE|有給休暇・バースデー休暇を選んでください' using errcode = 'check_violation';
  end if;
  if p_approver is null or p_approver = v_uid or not coalesce(public.role_is_manager_plus(p_approver), false) then
    raise exception 'LEAVE_CHANGE|申請先は、マネージャー以上の方にしてください' using errcode = 'check_violation';
  end if;
  select work_date into v_date from overtime_reports where id = p_ot;
  if exists (select 1 from leave_requests l where l.replaces_overtime_id = p_ot and l.status not in ('cancelled', 'rejected')) then
    raise exception 'LEAVE_CHANGE|%の時間外調整休は、すでに有休への変更を申請しています', public.jp_md_dow(v_date) using errcode = 'check_violation';
  end if;
  perform set_config('app.leave_from_chosei', '1', true);
  insert into leave_requests (id, user_id, leave_type, leave_dates, leave_locations, start_date, end_date, purpose, reason,
                              status, current_approver, approver_id, approver2_id, replaces_overtime_id)
  values (p_id, v_uid, p_leave_type, '["' || v_date::text || '"]',
          case when nullif(btrim(coalesce(p_location, '')), '') is null then null
               else jsonb_build_object(v_date::text, btrim(p_location))::text end,
          v_date, v_date, nullif(btrim(coalesce(p_purpose, '')), ''), nullif(btrim(coalesce(p_reason, '')), ''),
          -- 🚨 リーダーを飛ばしてマネージャーの受理の段から（2026-10-26 ユーザー決定）
          'step2_pending', 'first', p_approver, p_approver, p_ot);
  perform set_config('app.leave_from_chosei', '', true);
  return p_id;
end;
$function$;
revoke execute on function public.create_leave_from_chosei(uuid, uuid, text, uuid, text, text, text) from public;
revoke execute on function public.create_leave_from_chosei(uuid, uuid, text, uuid, text, text, text) from anon;
grant execute on function public.create_leave_from_chosei(uuid, uuid, text, uuid, text, text, text) to authenticated;

-- ───────── 見張り：印はあとから変えさせない・マネージャーの受理は締めのあと管理者だけ ─────────
create or replace function public.enforce_leave_replaces_overtime()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_admin boolean := coalesce(current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'role', '') = 'admin';
  v_role text := coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '');
  v_date date;
begin
  if tg_op = 'INSERT' then
    if new.replaces_overtime_id is not null and coalesce(current_setting('app.leave_from_chosei', true), '') <> '1' and v_role <> 'service_role' then
      raise exception 'LEAVE_CHANGE|時間外調整休からの変更は、残業ページの［有休に変更する］から申請してください' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.replaces_overtime_id is distinct from old.replaces_overtime_id then
    -- 時間外調整休の行が消えたとき（on delete set null）だけは通す
    if not (old.replaces_overtime_id is not null and new.replaces_overtime_id is null
            and not exists (select 1 from overtime_reports o where o.id = old.replaces_overtime_id)) then
      raise exception 'LEAVE_CHANGE|時間外調整休からの変更の印は、あとから変えられません' using errcode = 'check_violation';
    end if;
  end if;
  if new.replaces_overtime_id is null then return new; end if;
  if old.leave_dates is distinct from new.leave_dates or old.start_date is distinct from new.start_date or old.end_date is distinct from new.end_date
     or old.user_id is distinct from new.user_id or old.leave_type is distinct from new.leave_type then
    raise exception 'LEAVE_CHANGE|時間外調整休からの変更の休暇は、日付・種類を変えられません。取り消してから出し直してください' using errcode = 'check_violation';
  end if;
  -- マネージャーの受理（取消・差し戻しから戻すのも含む）で時間外調整休が取り消される＝締めのあとは管理者だけ（振替休日の変更と同じ）
  if old.status not in ('manager_approved', 'admin_approved', 'approved') and new.status in ('manager_approved', 'admin_approved', 'approved')
     and not v_admin and v_role <> 'service_role' then
    select work_date into v_date from overtime_reports where id = new.replaces_overtime_id;
    if public.payroll_close_passed(v_date) then
        raise exception 'LEAVE_CHANGE|給与計算が始まっているため（毎月17日以降）、変更の受理は管理者が行います' using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$function$;
revoke execute on function public.enforce_leave_replaces_overtime() from public;
revoke execute on function public.enforce_leave_replaces_overtime() from anon;
revoke execute on function public.enforce_leave_replaces_overtime() from authenticated;
drop trigger if exists trg_leave_replaces_overtime on public.leave_requests;
create trigger trg_leave_replaces_overtime before insert or update on public.leave_requests
  for each row execute function public.enforce_leave_replaces_overtime();

-- ───────── マネージャーの受理で取り消す・差し戻し／取消で元に戻す（同じ取引） ─────────
create or replace function public.apply_chosei_replacement()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_date date;
  v_msg text;
  v_snap jsonb;
  -- 履歴の「した人」（changed_by は必須）：ログインした人／サーバーの鍵なら見出しの人／どちらも無ければマネージャー
  v_actor uuid := coalesce(public.change_log_actor(), new.approver2_id, new.user_id);
begin
  if new.replaces_overtime_id is null or new.status is not distinct from old.status then return new; end if;
  select work_date into v_date from overtime_reports where id = new.replaces_overtime_id;

  -- マネージャーの受理（受理の段に入った瞬間・管理者が先へ進めたときも）
  if old.status not in ('manager_approved', 'admin_approved', 'approved') and new.status in ('manager_approved', 'admin_approved', 'approved') then
    -- 🚨 この取消で、時間外調整休の元の「申請の依頼」（段2a の案内など）を open に戻さない（reopen_application_request_on_cancel が見る）
    perform set_config('app.leave_replaced', '1', true);
    update overtime_reports set status = 'cancelled', replaced_by_leave_id = new.id
     where id = new.replaces_overtime_id and status = 'confirmed'
    returning to_jsonb(overtime_reports.*) into v_snap;
    perform set_config('app.leave_replaced', '', true);
    if v_snap is not null then
      insert into overtime_report_history (report_id, changed_by, change_kind, change_summary, change_reason, changes, snapshot)
      values (new.replaces_overtime_id, v_actor, 'cancelled', public.jp_md_dow(v_date) || 'を有給休暇に変更',
              '有給休暇（マネージャーの受理）による取消', jsonb_build_object('replaced_by_leave', new.id, 'date', v_date), v_snap);
    end if;
    return new;
  end if;

  -- 経理・社長の差し戻し／取消（受理の段から外れた瞬間）
  if old.status in ('manager_approved', 'admin_approved', 'approved') and new.status not in ('manager_approved', 'admin_approved', 'approved') then
    perform set_config('app.leave_replaced', '1', true);
    update overtime_reports set status = 'confirmed', replaced_by_leave_id = null
     where id = new.replaces_overtime_id and status = 'cancelled' and replaced_by_leave_id = new.id
    returning to_jsonb(overtime_reports.*) into v_snap;
    perform set_config('app.leave_replaced', '', true);
    if v_snap is not null then
      insert into overtime_report_history (report_id, changed_by, change_summary, change_reason, changes, snapshot)
      values (new.replaces_overtime_id, v_actor, public.jp_md_dow(v_date) || 'の時間外調整休を元に戻しました',
              case when new.status = 'cancelled' then '有給休暇への変更の取消' else '有給休暇への変更の差し戻し' end,
              jsonb_build_object('restored_from_leave', new.id, 'date', v_date), v_snap);
      begin
        v_msg := '🕐 有給休暇への変更が' || case when new.status = 'cancelled' then '取り消された' else '差し戻された' end
              || 'ため、' || public.jp_md_dow(v_date) || 'の時間外調整休を元に戻しました';
        insert into notifications (user_id, message, sub_message, source_type, event_key, reference_id, read)
        select distinct u, v_msg, null, 'overtime_request', null, new.replaces_overtime_id::text, false
          from unnest(array[new.user_id, new.approver2_id]) u
         where u is not null and u is distinct from v_actor;
      exception when others then
        raise warning '[apply_chosei_replacement] お知らせに失敗: %', sqlerrm;
      end;
    end if;
  end if;
  return new;
end;
$function$;
revoke execute on function public.apply_chosei_replacement() from public;
revoke execute on function public.apply_chosei_replacement() from anon;
revoke execute on function public.apply_chosei_replacement() from authenticated;
drop trigger if exists trg_leave_apply_chosei_replacement on public.leave_requests;
create trigger trg_leave_apply_chosei_replacement
  after update of status on public.leave_requests
  for each row when (new.replaces_overtime_id is not null)
  execute function public.apply_chosei_replacement();

-- ───────── 時間外調整休の側の印（replaced_by_leave_id）は、上のトリガーだけが書く ─────────
create or replace function public.enforce_ot_replaced_by_leave()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if new.replaced_by_leave_id is distinct from old.replaced_by_leave_id
     and coalesce(current_setting('app.leave_replaced', true), '') <> '1'
     and coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') <> 'service_role'
     -- 有休の行が消えたとき（on delete set null）
     and not (new.replaced_by_leave_id is null and not exists (select 1 from leave_requests l where l.id = old.replaced_by_leave_id)) then
    raise exception 'LEAVE_CHANGE|有給休暇への変更の印は、あとから変えられません' using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;
revoke execute on function public.enforce_ot_replaced_by_leave() from public;
revoke execute on function public.enforce_ot_replaced_by_leave() from anon;
revoke execute on function public.enforce_ot_replaced_by_leave() from authenticated;
drop trigger if exists trg_ot_replaced_by_leave on public.overtime_reports;
create trigger trg_ot_replaced_by_leave before update of replaced_by_leave_id on public.overtime_reports
  for each row execute function public.enforce_ot_replaced_by_leave();
-- ───────── 申請の依頼を open に戻さない（本番の実定義から・段2a の印を両方の表で見る） ─────────
CREATE OR REPLACE FUNCTION public.reopen_application_request_on_cancel()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- 2026-10-27 段2a：時間外調整休の受理で有休を取り消したときは、有休の元の依頼を open に戻さない
  -- 2026-10-27 段2b：有休の受理で時間外調整休を取り消したときも同じ（両方の表で見る）
  if coalesce(current_setting('app.leave_replaced', true), '') = '1' then
    return new;
  end if;
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    update application_requests
       set status = 'open', linked_id = null, updated_at = now()
     where linked_id = new.id and status = 'applied';
  end if;
  return new;
end;
$function$;

-- ───────── 重なり止め：変える1組（有休 ↔ 時間外調整休）だけは並んでよい（本番の実定義から） ─────────
drop function if exists public.my_day_off_conflict(date[], text, text, boolean, uuid);
drop function if exists public.day_off_conflict_message(uuid, date, text, text, text, uuid);

CREATE OR REPLACE FUNCTION public.day_off_conflict_message(p_user uuid, p_date date, p_side text, p_new text, p_verb text, p_skip_leave uuid DEFAULT NULL, p_skip_ot uuid DEFAULT NULL)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_existing text;
begin
  if p_side = 'overtime' then
    select '休暇申請（' || public.day_off_leave_label(l.leave_type) || '）' into v_existing
      from leave_requests l
     where l.user_id = p_user and l.status not in ('cancelled', 'rejected')
       and l.leave_dates is not null and l.leave_dates::jsonb ? p_date::text
       and l.id is distinct from p_skip_leave   -- 2026-10-27 段2a：変える有休は重なりに数えない
       and (p_skip_ot is null or l.replaces_overtime_id is distinct from p_skip_ot)   -- 2026-10-27 段2b：この時間外調整休を変える有休は数えない
     order by l.created_at limit 1;
  else
    select '残業申請（' || public.day_off_ot_label(o.application_types) || '）' into v_existing
      from overtime_reports o
     where o.applicant_id = p_user and o.work_date = p_date and o.entry_type = 'manual'
       and o.status not in ('cancelled', 'rejected', 'returned')
       and o.application_types && array['chosei_off', 'furikae_off', 'absence']   -- 2026-10-20：'ot_absence' は取り違え（本当の値は absence）
       and (p_skip_leave is null or o.replaces_leave_id is distinct from p_skip_leave)   -- 2026-10-27 段2a：この休暇を変える申請は数えない
       and o.id is distinct from p_skip_ot   -- 2026-10-27 段2b：有休に変える時間外調整休は数えない
     order by o.created_at limit 1;
  end if;
  if v_existing is null then return null; end if;
  return public.jp_md_dow(p_date) || 'はすでに' || v_existing || 'が出ています。同じ日に' || p_new || 'は' || p_verb ||
         'できません。内容を変えるときは、先に出ている申請を「📩 修正依頼」から取消・修正してください。';
end;
$function$;
revoke execute on function public.day_off_conflict_message(uuid, date, text, text, text, uuid, uuid) from public;
revoke execute on function public.day_off_conflict_message(uuid, date, text, text, text, uuid, uuid) from anon;
revoke execute on function public.day_off_conflict_message(uuid, date, text, text, text, uuid, uuid) from authenticated;

CREATE OR REPLACE FUNCTION public.my_day_off_conflict(p_dates date[], p_side text, p_kind text, p_encouragement boolean DEFAULT false, p_skip_leave uuid DEFAULT NULL, p_skip_ot uuid DEFAULT NULL)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  d date;
  v_msg text;
  v_new text;
  v_verb text;
  v_enc boolean;
begin
  if v_uid is null or p_side not in ('overtime', 'leave') then return null; end if;
  -- 2026-10-19 奨励日：奨励日の回答そのものは止めない（回答の画面からの確かめ）
  v_enc := not p_encouragement and (
    (p_side = 'leave' and public.encouragement_blocked_kind('leave', p_kind, null))
    or (p_side = 'overtime' and public.encouragement_blocked_kind('overtime', null, array[p_kind])));
  if p_side = 'overtime' then
    v_new := public.day_off_ot_label(array[p_kind]); v_verb := '申請';
    if v_new is null then return null; end if;
  elsif p_encouragement then
    v_new := '有休奨励日の休み（' || public.day_off_leave_label(p_kind) || '）'; v_verb := '回答';
  else
    v_new := '休暇申請（' || public.day_off_leave_label(p_kind) || '）'; v_verb := '申請';
  end if;
  foreach d in array coalesce(p_dates, '{}') loop
    if v_enc then
      v_msg := public.encouragement_block_message(v_uid, d);
      if v_msg is not null then return v_msg; end if;
    end if;
    -- 2026-10-27 段2a・2b：変える1組（p_skip_leave＝変える有休／p_skip_ot＝変える時間外調整休）は重なりに数えない
    v_msg := public.day_off_conflict_message(v_uid, d, p_side, v_new, v_verb, p_skip_leave, p_skip_ot);
    if v_msg is not null then return v_msg; end if;
  end loop;
  return null;
end;
$function$;
revoke execute on function public.my_day_off_conflict(date[], text, text, boolean, uuid, uuid) from public;
revoke execute on function public.my_day_off_conflict(date[], text, text, boolean, uuid, uuid) from anon;
grant execute on function public.my_day_off_conflict(date[], text, text, boolean, uuid, uuid) to authenticated, retiree;

CREATE OR REPLACE FUNCTION public.enforce_day_off_conflict_leave()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_new text;
  v_verb text;
  v_msg text;
  d text;
begin
  if new.status in ('cancelled', 'rejected') then return new; end if;
  if new.leave_dates is null then return new; end if;
  -- 2026-10-19 奨励日：種類（leave_type）・理由（reason）が変わったときも見る（日付も種類も同じ更新＝受理などは素通り）
  if tg_op = 'UPDATE'
     and old.status not in ('cancelled', 'rejected')
     and old.leave_dates is not distinct from new.leave_dates
     and old.leave_type is not distinct from new.leave_type
     and old.reason is not distinct from new.reason then
    return new;
  end if;
  if coalesce(new.reason, '') = '【有給奨励日】' then
    v_new := '有休奨励日の休み（' || public.day_off_leave_label(new.leave_type) || '）';
    v_verb := '回答';
  else
    v_new := '休暇申請（' || public.day_off_leave_label(new.leave_type) || '）';
    v_verb := '申請';
  end if;
  for d in select jsonb_array_elements_text(new.leave_dates::jsonb) loop
    -- 2026-10-19 奨励日：有給休暇・バースデー休暇は「奨励日の回答」から（先に見る）
    if public.encouragement_blocked_kind('leave', new.leave_type, null) then
      v_msg := public.encouragement_block_message(new.user_id, d::date);
      if v_msg is not null then raise exception 'DAYOFF_CONFLICT|%', v_msg; end if;
    end if;
    -- 2026-10-27 段2a：この休暇を変える時間外調整休（受理の前）は重なりに数えない
    -- 2026-10-27 段2b：この休暇で変える時間外調整休（マネージャーの受理の前）も数えない
    v_msg := public.day_off_conflict_message(new.user_id, d::date, 'leave', v_new, v_verb, new.id, new.replaces_overtime_id);
    if v_msg is not null then raise exception 'DAYOFF_CONFLICT|%', v_msg; end if;
  end loop;
  return new;
end;
$function$;

-- ───────── 段2a の案内の見張りの文（「変える」→「変更する」・2026-10-27 ユーザー確定・本番の実定義から1か所だけ） ─────────
CREATE OR REPLACE FUNCTION public.enforce_appreq_leave_replace()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role text := coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '');
  v_admin boolean := coalesce(current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'role', '') = 'admin';
  v_msg text;
  v_date date;
begin
  if tg_op = 'UPDATE' then
    -- 🚨 受け取った本人は行を書き換えられる（appreq_update に with check が無い）ので、要の列はあとから変えさせない
    if v_role <> 'service_role' and not v_admin and (
         new.requester_id is distinct from old.requester_id or new.recipient_id is distinct from old.recipient_id
      or new.kind is distinct from old.kind or new.target_dates is distinct from old.target_dates
      or new.ot_content is distinct from old.ot_content or new.replaces_leave_id is distinct from old.replaces_leave_id) then
      raise exception 'LEAVE_CHANGE|依頼の中身はあとから変えられません。取り下げてから作り直してください' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  if new.replaces_leave_id is null then return new; end if;
  if new.kind <> 'overtime' or coalesce(new.ot_content, '') <> 'chosei_off' or coalesce(array_length(new.target_dates, 1), 0) <> 1 then
    raise exception 'LEAVE_CHANGE|休暇の種類のご案内は、時間外調整休・1日だけです' using errcode = 'check_violation';
  end if;
  -- 2026-10-27 段2b：言葉を「変更する」にそろえた（ユーザー確定）
  if new.requester_id = new.recipient_id then
    raise exception 'LEAVE_CHANGE|ご自分の休暇は、休暇のカードの［時間外調整休に変更する］から変更してください' using errcode = 'check_violation';
  end if;
  if not public.user_has_feature_permission(new.requester_id, 'leave_type_change') then
    raise exception 'LEAVE_CHANGE|休暇の種類のご案内を送る権限がありません' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from profiles p where p.id = new.recipient_id and coalesce(p.is_active, true))
     or public.staff_on_leave(new.recipient_id) then
    raise exception 'LEAVE_CHANGE|この方には案内を送れません（退職・休職中）' using errcode = 'check_violation';
  end if;
  v_date := new.target_dates[1];
  v_msg := public.leave_replace_block(new.replaces_leave_id, new.recipient_id, v_date, true);
  if v_msg is not null then raise exception 'LEAVE_CHANGE|%', v_msg using errcode = 'check_violation'; end if;
  -- 🚨 同じ日の案内は1回限り（取り下げたものも数える・画面の注意書き「同じ日の案内は1回限りです」・2026-10-27 ユーザー確定）
  if exists (select 1 from application_requests a
              where a.replaces_leave_id = new.replaces_leave_id and a.target_dates = new.target_dates) then
    raise exception 'LEAVE_CHANGE|%の休暇の種類のご案内は、すでに送っています', public.jp_md_dow(v_date) using errcode = 'check_violation';
  end if;
  -- 回答の期限は付けない（期限の催促 remind-application-request が届かないように・法律の専門家のレビュー：回答しなければ有給休暇のまま）
  new.due_date := null;
  return new;
end;
$function$;

-- ───────── 時間外調整休の受理のお知らせ：元に戻したときは送らない（本番の実定義から） ─────────
CREATE OR REPLACE FUNCTION public.notify_overtime_fullday_fyi()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_site_on boolean; v_site_rcp text; v_push_on boolean; v_rcp jsonb;
  v_label text; v_name text; v_msg text; r record;
begin
  if new.entry_type is distinct from 'manual' then return new; end if;
  -- 2026-10-27 段2b：有給休暇への変更の差し戻しで時間外調整休を元に戻したとき（受理ではない）は送らない
  if coalesce(current_setting('app.leave_replaced', true), '') = '1' then return new; end if;
  if new.furikae_report_needed then
    -- 2026-10-26：振替元の日がまだ来ていない振替休日は、事前受理になったとき（新しく入れた／申請中から）だけ。確定のときは送らない
    --   🚨 今ある行の移行（確認済み → 事前受理）でも送らない（old.status が requested でないため）
    if new.status is distinct from 'request_confirmed' then return new; end if;
    if tg_op = 'UPDATE' and old.status is distinct from 'requested' then return new; end if;
  else
    if new.status is distinct from 'confirmed' then return new; end if;
    if tg_op = 'UPDATE' and old.status is not distinct from 'confirmed' then return new; end if;
  end if;
  if not (coalesce(new.application_types, '{}') && array['chosei_off', 'furikae_off', 'absence']) then return new; end if;

  begin
    select ns.enabled, ns.recipient into v_site_on, v_site_rcp
      from notification_settings ns where ns.event_key = 'leave:approved_fyi' and ns.channel = 'site';
    -- 🚨 休暇と同じ：設定が無い・OFF なら送らない
    if v_site_on is not true then return new; end if;
    select ns.enabled into v_push_on
      from notification_settings ns where ns.event_key = 'leave:approved_fyi' and ns.channel = 'push';
    begin
      v_rcp := coalesce(nullif(v_site_rcp, '')::jsonb, '{}'::jsonb);
    exception when others then v_rcp := '{}'::jsonb;
    end;

    v_label := case
      when 'chosei_off' = any(new.application_types) then '時間外調整休'
      when 'furikae_off' = any(new.application_types) then '振替休日'
      else '欠勤' end;
    select coalesce(name, '') into v_name from profiles where id = new.applicant_id;
    v_msg := '🕐 ' || v_label || 'が受理されました「' || v_name || '（' || extract(month from new.work_date)::int || '/' || extract(day from new.work_date)::int || '（' || (array['日','月','火','水','木','金','土'])[extract(dow from new.work_date)::int + 1] || '））」';

    for r in
      select rid as user_id from public.resolve_role_recipients(new.applicant_id, v_rcp) rid
       where rid <> new.applicant_id
    loop
      insert into notifications (user_id, message, sub_message, source_type, event_key, reference_id)
      values (r.user_id, v_msg,
              case when new.replaces_leave_id is not null then '有休から変更しました（この日の有休は取り消し）' end,   -- 2026-10-27 段2a
              'overtime:fullday_fyi',
              case when coalesce(v_push_on, false) then 'overtime:fullday_fyi' end,
              new.work_date::text);
    end loop;
  exception when others then
    -- 🚨 お知らせが送れなくても受理そのものは止めない
    raise warning '[notify_overtime_fullday_fyi] お知らせを送れませんでした: %', sqlerrm;
  end;
  return new;
end $function$;
