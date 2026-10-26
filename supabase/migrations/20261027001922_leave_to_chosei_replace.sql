-- 2026-10-27 段2a：有休を時間外調整休に変える（計画 docs/計画-言葉をそろえる-休暇の種類の変更.md の「2.」とユーザーの決定）
--
-- 入口は2つ・仕組みは1つ：
--   ① 上長の相談：application_requests に replaces_leave_id（kind='overtime'・ot_content='chosei_off'・target_dates は1日）
--   ② ご本人：有休のカードの［時間外調整休に変える］
--   どちらも、ご本人が残業申請（時間外調整休・終日）を replaces_leave_id 付きで出す
-- 🚨 有休を取り消すのは「時間外調整休が受理された瞬間」（同じ取引・案C）。受理までは、その1組だけ同じ日に並ぶことを認める
--    （差し戻し・本人の取消で「休みが1つも無い日」を作らないため。前例：振替休日の変更 furikae_change_apply）
-- 🚨 複数の日の有休は、その1日だけ leave_dates から抜く（全部の日なら取消）
-- 🚨 申請先はマネージャー以上（欠勤と同じ形）。相談を出せるのは権限「休暇の種類の変更の相談」（leave_type_change）がある人
-- 本番の実定義（2026-10-27 pg_get_functiondef）から起こした関数：link_application_request_on_insert／reopen_application_request_on_cancel／
--   enforce_day_off_conflict_leave／enforce_day_off_conflict_overtime／day_off_conflict_message／my_day_off_conflict（変えた所に 2026-10-27）

-- ───────── 列 ─────────
alter table public.application_requests
  add column if not exists replaces_leave_id uuid references public.leave_requests(id) on delete set null;
comment on column public.application_requests.replaces_leave_id is
  '有休を時間外調整休に変える相談のとき、変える休暇（2026-10-27 段2a）。日付は target_dates の1日';

alter table public.overtime_reports
  add column if not exists replaces_leave_id uuid references public.leave_requests(id) on delete set null,
  add column if not exists replaces_leave_date date;
comment on column public.overtime_reports.replaces_leave_id is
  'この時間外調整休が受理されたら取り消す（その日を抜く）休暇（2026-10-27 段2a）。あとから変えられない';
comment on column public.overtime_reports.replaces_leave_date is '変える休暇の日（＝work_date）';

create index if not exists overtime_reports_replaces_leave_idx on public.overtime_reports (replaces_leave_id) where replaces_leave_id is not null;
create index if not exists application_requests_replaces_leave_idx on public.application_requests (replaces_leave_id) where replaces_leave_id is not null;

-- ───────── 権限「休暇の種類の変更の相談」（最初はマネージャー・社長・管理者だけオン） ─────────
insert into public.feature_permissions (role_id, feature_key, enabled)
select r.id, 'leave_type_change', coalesce(r.is_manager_plus, false)
  from public.roles r
 where not exists (select 1 from public.feature_permissions f where f.role_id = r.id and f.feature_key = 'leave_type_change');

-- ───────── 変えられる休暇か（理由の文・変えられるなら null）。相談・申請の両方の見張りが使う1か所 ─────────
create or replace function public.leave_replace_block(p_leave uuid, p_user uuid, p_date date, p_check_close boolean)
 returns text
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
declare
  l record;
  v_pps date;
  v_cutoff date;
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_msg text;
begin
  select id, user_id, status, leave_type, reason, leave_dates into l from leave_requests where id = p_leave;
  if l.id is null or l.user_id is distinct from p_user then return 'この休暇は変えられません'; end if;
  if l.status in ('cancelled', 'rejected') then return 'この休暇はすでに取り消されています'; end if;
  if l.leave_type not in ('有給休暇', 'バースデー休暇（有給）') then return '時間外調整休に変えられるのは、有給休暇・バースデー休暇だけです'; end if;
  if coalesce(l.reason, '') = '【有給奨励日】' then return '有休奨励日の休みは変えられません'; end if;
  if p_date is null or l.leave_dates is null or not (l.leave_dates::jsonb ? p_date::text) then
    return public.jp_md_dow(p_date) || 'は、この休暇の日に入っていません';
  end if;
  -- 有休奨励日に時間外調整休が止まる日（奨励日の回答から）
  if public.encouragement_blocked_kind('overtime', null, array['chosei_off']) then
    v_msg := public.encouragement_block_message(p_user, p_date);
    if v_msg is not null then return v_msg; end if;
  end if;
  -- 給与の締め（支給月の17日を過ぎた期間）＝残業の新しい申請の締め（enforce_overtime_submission_window）と同じ日付
  if p_check_close then
    if extract(day from p_date) >= 16 then v_pps := date_trunc('month', p_date)::date + 15;
    else v_pps := (date_trunc('month', p_date) - interval '1 month')::date + 15; end if;
    v_cutoff := (date_trunc('month', v_pps + interval '1 month'))::date + 16;
    if v_today > v_cutoff then
      return '給与計算が始まっているため（毎月17日以降）変えられません。管理者に修正を依頼してください';
    end if;
  end if;
  return null;
end;
$function$;
revoke execute on function public.leave_replace_block(uuid, uuid, date, boolean) from public;
revoke execute on function public.leave_replace_block(uuid, uuid, date, boolean) from anon;
revoke execute on function public.leave_replace_block(uuid, uuid, date, boolean) from authenticated;

-- 画面から確かめる（本人の休暇・本人の日だけ）。null＝変えられる
create or replace function public.my_leave_replace_block(p_leave uuid, p_date date)
 returns text
 language sql
 stable security definer
 set search_path to 'public'
as $function$
  select case when auth.uid() is null then 'ログインしてください'
              else public.leave_replace_block(p_leave, auth.uid(), p_date, true) end;
$function$;
revoke execute on function public.my_leave_replace_block(uuid, date) from public;
revoke execute on function public.my_leave_replace_block(uuid, date) from anon;
grant execute on function public.my_leave_replace_block(uuid, date) to authenticated;

-- 上長の画面から確かめる（相手の休暇）。相談を出せる人だけ答える
create or replace function public.leave_replace_block_for(p_leave uuid, p_user uuid, p_date date)
 returns text
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if auth.uid() is null or not public.user_has_feature_permission(auth.uid(), 'leave_type_change') then
    return '休暇の種類のご案内を送る権限がありません';
  end if;
  return public.leave_replace_block(p_leave, p_user, p_date, true);
end;
$function$;
revoke execute on function public.leave_replace_block_for(uuid, uuid, date) from public;
revoke execute on function public.leave_replace_block_for(uuid, uuid, date) from anon;
grant execute on function public.leave_replace_block_for(uuid, uuid, date) to authenticated;

-- ───────── 相談（application_requests）の見張り ─────────
create or replace function public.enforce_appreq_leave_replace()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
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
  if new.requester_id = new.recipient_id then
    raise exception 'LEAVE_CHANGE|ご自分の休暇は、休暇のカードの［時間外調整休に変える］から変えてください' using errcode = 'check_violation';
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
revoke execute on function public.enforce_appreq_leave_replace() from public;
revoke execute on function public.enforce_appreq_leave_replace() from anon;
revoke execute on function public.enforce_appreq_leave_replace() from authenticated;
drop trigger if exists trg_appreq_leave_replace on public.application_requests;
create trigger trg_appreq_leave_replace before insert or update on public.application_requests
  for each row execute function public.enforce_appreq_leave_replace();

-- ───────── 申請（overtime_reports）の見張り ─────────
create or replace function public.enforce_overtime_replaces_leave()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_role text := coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '');
  v_admin boolean := coalesce(current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'role', '') = 'admin';
  v_msg text;
begin
  if tg_op = 'UPDATE' then
    if new.replaces_leave_id is distinct from old.replaces_leave_id or new.replaces_leave_date is distinct from old.replaces_leave_date then
      -- 休暇の行が消えたとき（on delete set null）だけは通す
      if not (old.replaces_leave_id is not null and new.replaces_leave_id is null
              and not exists (select 1 from leave_requests l where l.id = old.replaces_leave_id)) then
        raise exception 'LEAVE_CHANGE|休暇からの変更の印は、あとから変えられません' using errcode = 'check_violation';
      end if;
    end if;
    if old.replaces_leave_id is null then return new; end if;
    if new.work_date is distinct from old.work_date or new.applicant_id is distinct from old.applicant_id
       or new.application_types is distinct from old.application_types then
      raise exception 'LEAVE_CHANGE|有休からの変更の申請は、日付・種類を変えられません。取り消してから出し直してください' using errcode = 'check_violation';
    end if;
    if new.reviewer_id is distinct from old.reviewer_id and not coalesce(public.role_is_manager_plus(new.reviewer_id), false) then
      raise exception 'LEAVE_CHANGE|有休からの変更の申請先は、マネージャー以上の方にしてください' using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- INSERT
  if new.replaces_leave_id is null then
    new.replaces_leave_date := null;
    return new;
  end if;
  new.replaces_leave_date := coalesce(new.replaces_leave_date, new.work_date);
  if new.entry_type is distinct from 'manual' or new.application_types is distinct from array['chosei_off']::text[]
     or new.replaces_leave_date is distinct from new.work_date then
    raise exception 'LEAVE_CHANGE|有休からの変更は、その日の時間外調整休（終日）だけです' using errcode = 'check_violation';
  end if;
  if new.reviewer_id is null or not coalesce(public.role_is_manager_plus(new.reviewer_id), false) then
    raise exception 'LEAVE_CHANGE|有休からの変更の申請先は、マネージャー以上の方にしてください' using errcode = 'check_violation';
  end if;
  v_msg := public.leave_replace_block(new.replaces_leave_id, new.applicant_id, new.work_date,
                                      not (v_role = 'service_role' or v_admin));
  if v_msg is not null then raise exception 'LEAVE_CHANGE|%', v_msg using errcode = 'check_violation'; end if;
  -- 同じ有休・同じ日の変更が、まだ生きているなら二重にしない
  if exists (select 1 from overtime_reports o
              where o.replaces_leave_id = new.replaces_leave_id and o.work_date = new.work_date
                and o.status not in ('cancelled', 'rejected', 'returned')) then
    raise exception 'LEAVE_CHANGE|%の有休は、すでに時間外調整休への変更を申請しています', public.jp_md_dow(new.work_date) using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;
revoke execute on function public.enforce_overtime_replaces_leave() from public;
revoke execute on function public.enforce_overtime_replaces_leave() from anon;
revoke execute on function public.enforce_overtime_replaces_leave() from authenticated;
drop trigger if exists trg_overtime_replaces_leave on public.overtime_reports;
create trigger trg_overtime_replaces_leave
  before insert or update of replaces_leave_id, replaces_leave_date, work_date, applicant_id, application_types, reviewer_id
  on public.overtime_reports for each row execute function public.enforce_overtime_replaces_leave();

-- ───────── 受理された瞬間に有休を取り消す（その日を抜く）。同じ取引 ─────────
create or replace function public.apply_leave_replacement()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  l record;
  v_dates text[];
  v_rest text[];
  v_locs jsonb;
  v_actor uuid := public.change_log_actor();
  v_name text;
  v_set jsonb;
  v_rcp jsonb;
  v_msg text;
  v_ids uuid[];
  v_fyi uuid[];
begin
  if new.replaces_leave_id is null or new.status <> 'confirmed' then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'confirmed' then return new; end if;

  select * into l from leave_requests where id = new.replaces_leave_id for update;
  if l.id is null or l.status in ('cancelled', 'rejected') or l.leave_dates is null
     or not (l.leave_dates::jsonb ? new.work_date::text) then
    raise notice '[apply_leave_replacement] 休暇はすでに取り消されているか、その日が無い（%）', new.replaces_leave_id;
    return new;
  end if;

  select coalesce(array_agg(x order by x), '{}') into v_dates from jsonb_array_elements_text(l.leave_dates::jsonb) x;
  v_rest := array_remove(v_dates, new.work_date::text);

  -- 🚨 この取消で、休暇の元の「申請の依頼」を open に戻さない（reopen_application_request_on_cancel が見る）
  perform set_config('app.leave_replaced', '1', true);
  if coalesce(array_length(v_rest, 1), 0) = 0 then
    update leave_requests set status = 'cancelled', updated_at = now() where id = l.id;
    insert into leave_request_history (leave_request_id, change_kind, change_summary, change_reason, changes, snapshot, changed_by)
    values (l.id, 'cancelled', public.jp_md_dow(new.work_date) || 'を時間外調整休に変更', '時間外調整休の受理による取消',
            jsonb_build_object('replaced_by', new.id, 'date', new.work_date), to_jsonb(l), coalesce(v_actor, new.reviewer_id));
  else
    begin
      v_locs := case when l.leave_locations is null then null else (l.leave_locations::jsonb - new.work_date::text) end;
    exception when others then v_locs := null; end;
    update leave_requests
       set leave_dates = '[' || (select string_agg('"' || x || '"', ',' order by x) from unnest(v_rest) x) || ']',   -- 画面の JSON.stringify と同じ形（空白なし）
           start_date = v_rest[1]::date,
           end_date = v_rest[array_length(v_rest, 1)]::date,
           leave_locations = case when v_locs is null or v_locs = '{}'::jsonb then l.leave_locations
                                  else v_locs::text end,
           updated_at = now()
     where id = l.id;
    insert into leave_request_history (leave_request_id, change_kind, change_summary, change_reason, changes, snapshot, changed_by)
    values (l.id, 'type_change', public.jp_md_dow(new.work_date) || 'を時間外調整休に変更（ほかの日は有休のまま）', '時間外調整休の受理による変更',
            jsonb_build_object('replaced_by', new.id, 'date', new.work_date), to_jsonb(l), coalesce(v_actor, new.reviewer_id));
  end if;
  perform set_config('app.leave_replaced', '', true);

  -- 休暇の受理者へベル（スマホなし）。🚨 時間外調整休の受理のお知らせ（notify_overtime_fullday_fyi・leave:approved_fyi の相手）を
  --    受け取る人には送らない（同じ人に2通にしない・あちらの文に「有休から変更」を足した）。失敗しても取消は止めない
  begin
    select name into v_name from profiles where id = new.applicant_id;
    v_ids := array_remove(array[l.approver_id, l.approver2_id], null);
    select recipient::jsonb into v_rcp from notification_settings
     where event_key = 'leave:approved_fyi' and channel = 'site' and enabled;
    v_fyi := case when v_rcp is null then '{}'::uuid[]
                  else coalesce((select array_agg(x) from public.resolve_role_recipients(new.applicant_id, v_rcp) x), '{}') end;
    v_msg := '🕐 有休が時間外調整休に変わりました「' || coalesce(v_name, '') || '（' || public.jp_md_dow(new.work_date) || '）」';
    insert into notifications (user_id, message, sub_message, source_type, event_key, reference_id, read)
    select distinct u, v_msg, 'この日の有休は取り消されました', 'overtime:fullday_fyi', null, new.work_date::text, false
      from unnest(v_ids) u
     where u is not null and u <> new.applicant_id and u is distinct from v_actor and not (u = any(v_fyi));
  exception when others then
    raise warning '[apply_leave_replacement] お知らせに失敗: %', sqlerrm;
  end;
  return new;
end;
$function$;
revoke execute on function public.apply_leave_replacement() from public;
revoke execute on function public.apply_leave_replacement() from anon;
revoke execute on function public.apply_leave_replacement() from authenticated;
-- 🚨 名前は trg_zz_* より前（シフト調整の作り直しより先に休暇を片付ける・どちらの順でも結果は同じ）
drop trigger if exists trg_overtime_apply_leave_replacement on public.overtime_reports;
create trigger trg_overtime_apply_leave_replacement
  after insert or update of status on public.overtime_reports
  for each row when (new.replaces_leave_id is not null and new.status = 'confirmed')
  execute function public.apply_leave_replacement();

-- ───────── 申請の依頼との結び付け（本番の実定義から） ─────────
CREATE OR REPLACE FUNCTION public.link_application_request_on_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_kind text;
  v_user uuid;
  v_dates date[];
begin
  if tg_table_name = 'overtime_reports' then
    if new.entry_type is distinct from 'manual' or new.status = 'cancelled' then return new; end if;
    v_kind := 'overtime';
    v_user := new.applicant_id;
    v_dates := array[new.work_date];
    -- 2026-10-27 段2a：有休からの変更は、その有休の相談だけと結ぶ（ID で）。ふつうの残業の依頼とは結ばない
    if new.replaces_leave_id is not null then
      update application_requests
         set status = 'applied', linked_id = new.id, responded_at = now(), updated_at = now()
       where recipient_id = v_user and kind = 'overtime' and status = 'open'
         and replaces_leave_id = new.replaces_leave_id and target_dates && v_dates;
      return new;
    end if;
  elsif tg_table_name = 'leave_requests' then
    if new.status = 'cancelled' then return new; end if;
    v_kind := 'leave';
    v_user := new.user_id;
    begin
      select coalesce(array_agg(d::date), array[]::date[]) into v_dates
        from jsonb_array_elements_text(new.leave_dates::jsonb) as d;
    exception when others then
      v_dates := array[]::date[];
    end;
    if coalesce(array_length(v_dates, 1), 0) = 0 and new.start_date is not null then
      select array_agg(g::date) into v_dates
        from generate_series(new.start_date, coalesce(new.end_date, new.start_date), interval '1 day') as g;
    end if;
  else
    return new;
  end if;

  if v_user is null or coalesce(array_length(v_dates, 1), 0) = 0 then return new; end if;

  update application_requests
     set status = 'applied', linked_id = new.id, responded_at = now(), updated_at = now()
   where recipient_id = v_user
     and kind = v_kind
     and status = 'open'
     and replaces_leave_id is null   -- 2026-10-27 段2a：有休の種類の変更の相談は、ID で結ぶものだけ
     and target_dates && v_dates;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.reopen_application_request_on_cancel()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- 2026-10-27 段2a：時間外調整休の受理で有休を取り消したときは、有休の元の依頼を open に戻さない
  if tg_table_name = 'leave_requests' and coalesce(current_setting('app.leave_replaced', true), '') = '1' then
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

-- ───────── 休暇と終日の休みの重なり止め：変える1組だけは並んでよい（本番の実定義から） ─────────
drop function if exists public.my_day_off_conflict(date[], text, text, boolean);
drop function if exists public.day_off_conflict_message(uuid, date, text, text, text);

CREATE OR REPLACE FUNCTION public.day_off_conflict_message(p_user uuid, p_date date, p_side text, p_new text, p_verb text, p_skip_leave uuid DEFAULT NULL)
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
     order by l.created_at limit 1;
  else
    select '残業申請（' || public.day_off_ot_label(o.application_types) || '）' into v_existing
      from overtime_reports o
     where o.applicant_id = p_user and o.work_date = p_date and o.entry_type = 'manual'
       and o.status not in ('cancelled', 'rejected', 'returned')
       and o.application_types && array['chosei_off', 'furikae_off', 'absence']   -- 2026-10-20：'ot_absence' は取り違え（本当の値は absence）
       and (p_skip_leave is null or o.replaces_leave_id is distinct from p_skip_leave)   -- 2026-10-27 段2a：この休暇を変える申請は数えない
     order by o.created_at limit 1;
  end if;
  if v_existing is null then return null; end if;
  return public.jp_md_dow(p_date) || 'はすでに' || v_existing || 'が出ています。同じ日に' || p_new || 'は' || p_verb ||
         'できません。内容を変えるときは、先に出ている申請を「📩 修正依頼」から取消・修正してください。';
end;
$function$;
revoke execute on function public.day_off_conflict_message(uuid, date, text, text, text, uuid) from public;
revoke execute on function public.day_off_conflict_message(uuid, date, text, text, text, uuid) from anon;
revoke execute on function public.day_off_conflict_message(uuid, date, text, text, text, uuid) from authenticated;

CREATE OR REPLACE FUNCTION public.my_day_off_conflict(p_dates date[], p_side text, p_kind text, p_encouragement boolean DEFAULT false, p_skip_leave uuid DEFAULT NULL)
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
    -- 2026-10-27 段2a：p_skip_leave＝有休から変える申請のとき、その有休を重なりに数えない
    v_msg := public.day_off_conflict_message(v_uid, d, p_side, v_new, v_verb, p_skip_leave);
    if v_msg is not null then return v_msg; end if;
  end loop;
  return null;
end;
$function$;
revoke execute on function public.my_day_off_conflict(date[], text, text, boolean, uuid) from public;
revoke execute on function public.my_day_off_conflict(date[], text, text, boolean, uuid) from anon;
grant execute on function public.my_day_off_conflict(date[], text, text, boolean, uuid) to authenticated, retiree;

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
    v_msg := public.day_off_conflict_message(new.user_id, d::date, 'leave', v_new, v_verb, new.id);
    if v_msg is not null then raise exception 'DAYOFF_CONFLICT|%', v_msg; end if;
  end loop;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.enforce_day_off_conflict_overtime()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_label text;
  v_msg text;
begin
  if new.entry_type is distinct from 'manual' then return new; end if;
  if new.status in ('cancelled', 'rejected', 'returned') then return new; end if;
  v_label := public.day_off_ot_label(new.application_types);
  if v_label is null then return new; end if;
  if tg_op = 'UPDATE'
     and old.status not in ('cancelled', 'rejected', 'returned')
     and old.work_date = new.work_date
     and old.application_types is not distinct from new.application_types then
    return new;
  end if;
  -- 2026-10-19 奨励日：時間外調整休は「奨励日の回答」から（先に見る）
  if public.encouragement_blocked_kind('overtime', null, new.application_types) then
    v_msg := public.encouragement_block_message(new.applicant_id, new.work_date);
    if v_msg is not null then raise exception 'DAYOFF_CONFLICT|%', v_msg; end if;
  end if;
  -- 2026-10-27 段2a：有休から変える申請は、その有休を重なりに数えない
  v_msg := public.day_off_conflict_message(new.applicant_id, new.work_date, 'overtime', v_label, '申請', new.replaces_leave_id);
  if v_msg is not null then raise exception 'DAYOFF_CONFLICT|%', v_msg; end if;
  return new;
end;
$function$;

-- ───────── 時間外調整休の受理のお知らせに「有休から変更」（本番の実定義から・変えたのは sub_message の1か所） ─────────
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
