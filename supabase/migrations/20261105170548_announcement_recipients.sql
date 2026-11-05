-- 管理者からのお知らせに宛先（2026-11-05 ユーザー確定・シニアエンジニアのレビュー済み・計画 docs/計画-管理者からのお知らせの宛先.md）
-- ・宛先は作った時点で人に展開して announcement_recipients に入れる（あとから入った人には出ない）。展開は画面（lib/recipientPresets・連絡板と同じ判定）。
--   DB は在籍しているか・権限だけ確かめる（announcement_set_recipients）
-- ・audience：'all'＝全員（今までのお知らせ・古い画面で作ったもの）／'list'＝宛先の表の人だけ。🚨 「宛先の行が無い＝全員」にはしない（全部外す・書き込みの失敗で全員に化けるため）
-- ・見える判定は announcement_visible 1か所（読む権限・my_active_announcements・my_announcement_history）。my_home_feed は同じ条件を書いた（security definer のため）
-- ・送った印は宛先の1人ごと（announcement_recipients.notified_at）。宛先を足した人への通知は印の無い人だけ（announcement_claim_recipients・Edge Function announcement-notify）
-- ・外した人：ベル（event_key announcement:new／announcement:remind・reference_id＝お知らせの id）と、送信待ちのスマホ通知（push_queue の pending）を消す。
--   🚨 メール・届いたスマホの通知は取り消せない。push_deferred（休みの日などで保留中）は reference_id が無く消せない
-- ・my_home_feed と announcements_guard_system_columns は 2026-11-05 の本番の実定義から起こした

alter table public.announcements add column if not exists audience text not null default 'all';
alter table public.announcements drop constraint if exists announcements_audience_check;
alter table public.announcements add constraint announcements_audience_check check (audience in ('all', 'list'));
alter table public.announcements add column if not exists recipient_presets text[] not null default '{}';
alter table public.announcements add column if not exists recipient_extra_ids uuid[] not null default '{}';
comment on column public.announcements.audience is 'all＝全員（今までのお知らせ）／list＝announcement_recipients の人だけ。宛先は announcement_set_recipients からだけ変える';
comment on column public.announcements.recipient_presets is '押した宛先のボタン（表示用の控え・判定には使わない）';
comment on column public.announcements.recipient_extra_ids is 'ボタン以外で足した人（表示用の控え・判定には使わない）';

create table if not exists public.announcement_recipients (
  announcement_id uuid not null references public.announcements(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  added_at timestamptz not null default now(),
  removed_at timestamptz,
  notified_at timestamptz,
  primary key (announcement_id, user_id)
);
create index if not exists announcement_recipients_user_idx on public.announcement_recipients (user_id);
alter table public.announcement_recipients enable row level security;
drop policy if exists announcement_recipients_select on public.announcement_recipients;
create policy announcement_recipients_select on public.announcement_recipients for select to authenticated
  using (user_id = auth.uid() or (select public.can_manage_admin_tab('announcements')));
revoke all on public.announcement_recipients from anon, authenticated;
grant select on public.announcement_recipients to authenticated;
grant all on public.announcement_recipients to service_role;
comment on table public.announcement_recipients is '管理者からのお知らせの宛先（作った時点の人）。書くのは announcement_set_recipients と service_role だけ';

-- 見える判定（1か所）。🚨 引数に人を取らない（だれが宛先か他人が探れないように・auth.uid() を使う）
create or replace function public.announcement_visible(p_id uuid)
returns boolean language sql stable security definer set search_path to 'public' as $f$
  select exists (
    select 1 from announcements a
     where a.id = p_id
       and (a.audience = 'all'
            or exists (select 1 from announcement_recipients r
                        where r.announcement_id = a.id and r.user_id = auth.uid() and r.removed_at is null)));
$f$;
revoke all on function public.announcement_visible(uuid) from public;
revoke all on function public.announcement_visible(uuid) from anon;
grant execute on function public.announcement_visible(uuid) to authenticated, service_role;

-- 読む権限：宛先どおり（管理画面のお知らせのタブを開ける人は announcements_admin_write＝FOR ALL で全件読める）
drop policy if exists announcements_select_all on public.announcements;
drop policy if exists announcements_select_visible on public.announcements;
create policy announcements_select_visible on public.announcements for select to authenticated
  using (public.announcement_visible(id));

-- ホームの帯・過去のお知らせ：管理画面の権限がある人にも宛先どおりに出す（FOR ALL の読みで宛先外まで出ないように）
create or replace function public.my_active_announcements()
returns setof public.announcements language sql stable security invoker set search_path to 'public' as $f$
  select a.* from announcements a
   where a.active and (a.starts_at is null or a.starts_at <= now()) and (a.ends_at is null or a.ends_at >= now())
     and public.announcement_visible(a.id)
   order by a.created_at desc;
$f$;
revoke all on function public.my_active_announcements() from public;
revoke all on function public.my_active_announcements() from anon;
grant execute on function public.my_active_announcements() to authenticated;

create or replace function public.my_announcement_history()
returns setof public.announcements language sql stable security invoker set search_path to 'public' as $f$
  select a.* from announcements a
   where a.active and public.announcement_visible(a.id)
   order by a.created_at desc
   limit 200;
$f$;
revoke all on function public.my_announcement_history() from public;
revoke all on function public.my_announcement_history() from anon;
grant execute on function public.my_announcement_history() to authenticated;

-- 宛先を決める・直す（作るときも直すときもこれ1本）。p_user_ids は画面で展開した人（在籍の人だけ残す）
-- 返り値：added_unnotified＝通知がまだの人（作成時・足した人）の数／removed＝外した数／removed_notified＝外した人のうち通知が届いていた数／total
create or replace function public.announcement_set_recipients(p_id uuid, p_user_ids uuid[], p_presets text[], p_extra_ids uuid[])
returns jsonb language plpgsql security definer set search_path to 'public' as $f$
declare
  v_ann announcements%rowtype;
  v_ids uuid[];
  v_removed uuid[];
  v_removed_notified int := 0;
  v_added int := 0;
begin
  if not public.can_manage_admin_tab('announcements') then
    raise exception 'お知らせの宛先を変える権限がありません' using errcode = '42501';
  end if;
  select * into v_ann from announcements where id = p_id for update;
  if not found then raise exception 'お知らせが見つかりません' using errcode = 'P0002'; end if;

  select coalesce(array_agg(distinct p.id), '{}') into v_ids
    from profiles p where p.id = any (coalesce(p_user_ids, '{}')) and p.is_active;
  if cardinality(v_ids) = 0 then
    raise exception 'お知らせを届ける人がいません（宛先を選んでください）' using errcode = '22023';
  end if;

  if v_ann.audience = 'all' then
    -- 全員あてから直すとき：今の在籍者のうち宛先に残らない人が「外した人」。送った印はお知らせの notified_at
    select coalesce(array_agg(p.id), '{}') into v_removed
      from profiles p where p.is_active and not (p.id = any (v_ids));
    if v_ann.notified_at is not null and (v_ann.notify_on_create_push or v_ann.notify_on_create_email) then
      v_removed_notified := cardinality(v_removed);
    end if;
    insert into announcement_recipients (announcement_id, user_id, notified_at)
    select p_id, u, v_ann.notified_at from unnest(v_ids) u
    on conflict (announcement_id, user_id) do update set removed_at = null;
  else
    with gone as (
      update announcement_recipients r set removed_at = now()
       where r.announcement_id = p_id and r.removed_at is null and not (r.user_id = any (v_ids))
      returning r.user_id, r.notified_at)
    select coalesce(array_agg(user_id), '{}'), count(*) filter (where notified_at is not null)
      into v_removed, v_removed_notified from gone;
    insert into announcement_recipients (announcement_id, user_id)
    select p_id, u from unnest(v_ids) u
    on conflict (announcement_id, user_id) do update set removed_at = null;
  end if;

  select count(*) into v_added from announcement_recipients r
   where r.announcement_id = p_id and r.removed_at is null and r.notified_at is null;

  perform set_config('app.ann_recipients', 'on', true);
  update announcements set audience = 'list', recipient_presets = coalesce(p_presets, '{}'),
         recipient_extra_ids = coalesce(p_extra_ids, '{}'), updated_at = now()
   where id = p_id;
  perform set_config('app.ann_recipients', '', true);

  -- 外した人のベルと、まだ送っていないスマホ通知を消す
  if cardinality(v_removed) > 0 then
    delete from notifications n
     where n.user_id = any (v_removed) and n.reference_id = p_id::text
       and n.event_key in ('announcement:new', 'announcement:remind');
    delete from push_queue q
     where q.user_id = any (v_removed) and q.reference_id = p_id::text and q.status = 'pending'
       and q.event_key in ('announcement:new', 'announcement:remind');
  end if;

  return jsonb_build_object('total', cardinality(v_ids), 'added_unnotified', v_added,
                            'removed', cardinality(v_removed), 'removed_notified', v_removed_notified);
end;
$f$;
revoke all on function public.announcement_set_recipients(uuid, uuid[], text[], uuid[]) from public;
revoke all on function public.announcement_set_recipients(uuid, uuid[], text[], uuid[]) from anon;
grant execute on function public.announcement_set_recipients(uuid, uuid[], text[], uuid[]) to authenticated;

-- 送る相手（Edge Function の通知・リマインドが使う・service_role だけ）：全員あてなら在籍者全員、宛先ありなら外していない宛先の在籍者
create or replace function public.announcement_audience_ids(p_id uuid)
returns setof uuid language sql stable security definer set search_path to 'public' as $f$
  select p.id from profiles p join announcements a on a.id = p_id
   where p.is_active
     and (a.audience = 'all'
          or exists (select 1 from announcement_recipients r
                      where r.announcement_id = a.id and r.user_id = p.id and r.removed_at is null));
$f$;
revoke all on function public.announcement_audience_ids(uuid) from public;
revoke all on function public.announcement_audience_ids(uuid) from anon, authenticated;
grant execute on function public.announcement_audience_ids(uuid) to service_role;

-- 作成時・足した人への通知の印を取る（service_role だけ）。印の無い人だけ・二度押しでも二重に送らない。p_user_ids が空なら宛先の全員
create or replace function public.announcement_claim_recipients(p_id uuid, p_user_ids uuid[] default null)
returns setof uuid language sql security definer set search_path to 'public' as $f$
  update announcement_recipients r set notified_at = now()
    from profiles p
   where r.announcement_id = p_id and r.removed_at is null and r.notified_at is null
     and p.id = r.user_id and p.is_active
     and (p_user_ids is null or r.user_id = any (p_user_ids))
  returning r.user_id;
$f$;
revoke all on function public.announcement_claim_recipients(uuid, uuid[]) from public;
revoke all on function public.announcement_claim_recipients(uuid, uuid[]) from anon, authenticated;
grant execute on function public.announcement_claim_recipients(uuid, uuid[]) to service_role;

CREATE OR REPLACE FUNCTION public.announcements_guard_system_columns()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  -- 宛先（audience・recipient_presets・recipient_extra_ids）は announcement_set_recipients からだけ変える（2026-11-05）。
  -- 作るときは list か all を入れてよい（古い画面は既定の all）
  if tg_op = 'UPDATE' and current_user = 'authenticated'
     and coalesce(current_setting('app.ann_recipients', true), '') <> 'on'
     and (new.audience is distinct from old.audience
          or new.recipient_presets is distinct from old.recipient_presets
          or new.recipient_extra_ids is distinct from old.recipient_extra_ids) then
    raise exception 'お知らせの宛先は、宛先の欄から直してください' using errcode = '42501';
  end if;

  if current_user <> 'authenticated' or public.is_admin() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.created_by is distinct from auth.uid() then
      raise exception 'お知らせの作成者は自分にしてください' using errcode = '42501';
    end if;
    if new.notified_at is not null or new.remind_last_sent_on is not null then
      raise exception '送信済みの印は付けられません' using errcode = '42501';
    end if;
  else
    if new.created_by is distinct from old.created_by
       or new.notified_at is distinct from old.notified_at
       or new.remind_last_sent_on is distinct from old.remind_last_sent_on then
      raise exception 'お知らせの作成者と送信済みの印は、管理者しか変えられません' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$function$;

CREATE OR REPLACE FUNCTION public.my_home_feed()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid     uuid := auth.uid();
  v_today   date := (now() at time zone 'Asia/Tokyo')::date;
  v_items   jsonb := '[]'::jsonb;
  v_active  boolean;
  v_emp     text;
  v_admin   boolean := coalesce(is_admin(), false);
  v_pay     jsonb;
  v_ot      jsonb;
  v_period  date;
  v_last    timestamptz;
  v_seen    timestamptz;
  v_pub     boolean;
begin
  if v_uid is null then return jsonb_build_object('seen_at', null, 'items', '[]'::jsonb); end if;
  select coalesce(is_active, false), coalesce(employment_type, '正社員'), home_seen_at
    into v_active, v_emp, v_seen from profiles where id = v_uid;

  -- 締め日（退職者にも出す）。dismissed＝［確認した］済み
  begin
    v_pay := my_payroll_close_notice();
  exception when others then v_pay := null;
  end;
  if v_pay is not null and v_pay ? 'close_date' then
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'k', 'pay:' || (v_pay->>'close_date'), 'kind', 'payroll',
      'at', (select r.created_at from payroll_close_notice_recipients r where r.user_id = v_uid and r.close_date = (v_pay->>'close_date')::date),
      'acked', coalesce((v_pay->>'dismissed')::boolean, false)));
  end if;

  -- 退職者（在籍外）は締め日だけ
  if not coalesce(v_active, false) then
    return jsonb_build_object('seen_at', v_seen, 'items', v_items);
  end if;

  -- 安否確認：公開設定（管理者・全公開・リーダー以上に先行・社長だけに先行）＋宛先で未回答
  select v_admin
      or coalesce((select (value->>'safety_check') from app_settings where key = 'feature_published'), 'true') <> 'false'
      or (coalesce((select (value->>'safety_check') from app_settings where key = 'feature_published_leader'), 'false') = 'true'
          and exists (select 1 from profiles p join roles r on r.id = p.role_id where p.id = v_uid and r.is_leader_plus))
      or (coalesce((select (value->>'safety_check') from app_settings where key = 'feature_published_president'), 'false') = 'true'
          and exists (select 1 from profiles p join roles r on r.id = p.role_id where p.id = v_uid and r.is_org_wide))
    into v_pub;
  if v_pub then
    v_items := v_items || coalesce((select jsonb_agg(jsonb_build_object('k', 'safe:' || c.id, 'kind', 'safety', 'at', c.created_at, 'acked', false))
      from safety_checks c
      join safety_check_recipients rc on rc.check_id = c.id and rc.user_id = v_uid
      where c.status = 'active' and not coalesce(c.cancelled, false)
        and not exists (select 1 from safety_check_responses s where s.check_id = c.id and s.user_id = v_uid)), '[]'::jsonb);
  end if;

  -- 管理者からのお知らせ：期間中。再掲の期間（JST の日付）に入ったら別の印（もう一度新着になる）
  v_items := v_items || coalesce((select jsonb_agg(jsonb_build_object('k', x.k, 'kind', 'announcement', 'at', x.at,
      'acked', exists (select 1 from home_acks h where h.user_id = v_uid and h.item_key = x.k)))
    from (
      select a.id,
             'ann:' || a.id || ':' || case when x2.remind then 'r' else 'n' end as k,
             case when x2.remind
                  then (((a.ends_at at time zone 'Asia/Tokyo')::date - coalesce(a.remind_days_before, 0))::timestamp at time zone 'Asia/Tokyo')
                  else coalesce(a.starts_at, a.created_at) end as at
      from announcements a
      cross join lateral (select (coalesce(a.remind_in_app, false) and a.ends_at is not null
               and v_today between ((a.ends_at at time zone 'Asia/Tokyo')::date - coalesce(a.remind_days_before, 0))
                               and (a.ends_at at time zone 'Asia/Tokyo')::date) as remind) x2
      where a.active and (a.starts_at is null or a.starts_at <= now()) and (a.ends_at is null or a.ends_at >= now())
        -- 宛先（2026-11-05）：全員あて、または宛先に入っている（外されていない）お知らせだけ。判定は announcement_visible と同じ
        and (a.audience = 'all' or exists (select 1 from announcement_recipients ar
              where ar.announcement_id = a.id and ar.user_id = v_uid and ar.removed_at is null))
    ) x), '[]'::jsonb);

  -- 催促：同じリマインドは最新の配信の1行だけ。「後で」の期限内は出さない
  v_items := v_items || coalesce((select jsonb_agg(jsonb_build_object(
      'k', 'rem:' || l.id || ':' || coalesce(to_char(l.snooze_until, 'YYYYMMDDHH24MI'), ''), 'kind', 'reminder',
      'at', case when l.status = 'snoozed' then l.snooze_until else l.created_at end, 'acked', false))
    from (
      select distinct on (r.reminder_id) r.*
      from scheduled_reminder_responses r
      join board_scheduled_reminders b on b.id = r.reminder_id and b.is_active
      where r.user_id = v_uid and r.status in ('pending', 'snoozed')
      order by r.reminder_id, r.delivered_on desc
    ) l
    where l.status = 'pending' or (l.status = 'snoozed' and (l.snooze_until is null or l.snooze_until <= now()))), '[]'::jsonb);

  -- 有休奨励日：対象で未回答（期限切れも出す）
  v_items := v_items || coalesce((select jsonb_agg(jsonb_build_object('k', 'enc:' || d.id, 'kind', 'encouragement', 'at', d.created_at, 'acked', false))
    from paid_leave_encouragement_targets t
    join paid_leave_encouragement_days d on d.id = t.encouragement_day_id
    where t.user_id = v_uid
      and not exists (select 1 from paid_leave_encouragement_responses s where s.encouragement_day_id = d.id and s.user_id = v_uid)), '[]'::jsonb);

  -- 出勤のお願い：パートだけ・未回答で、まだ決まっていない今日以降
  if v_emp = 'パート' then
    v_items := v_items || coalesce((select jsonb_agg(jsonb_build_object('k', 'part:' || r.id, 'kind', 'part_request', 'at', r.sent_at, 'acked', false))
      from shift_adjust_part_requests r
      join shift_adjust_slots s on s.id = r.slot_id
      where r.user_id = v_uid and r.target_date >= v_today and r.answer is null and s.status <> 'decided'), '[]'::jsonb);
  end if;

  -- 残業の目安超え（本人・上長は部門ごと・部門名は印に入れず md5 の先頭8文字）。送った時刻が変わる（超えた・毎月の決まった日）と印が変わる＝もう一度新着
  if v_admin or coalesce(has_feature_permission('overtime'), false) then
    v_period := calc_pay_period_start(v_today);
    begin
      v_ot := overtime_threshold_banner(v_period);
    exception when others then v_ot := null;
    end;
    if v_ot is not null then
      v_last := nullif(v_ot->>'last_sent', '')::timestamptz;
      if jsonb_typeof(v_ot->'self') = 'object' then
        v_items := v_items || jsonb_build_array(jsonb_build_object(
          'k', 'ots:' || v_period || ':' || coalesce(to_char(v_last, 'YYYYMMDDHH24MISS'), '0'), 'kind', 'overtime_self',
          'at', coalesce(v_last, v_period::timestamptz), 'acked', false));
      end if;
      if jsonb_typeof(v_ot->'members') = 'array' and jsonb_array_length(v_ot->'members') > 0 then
        v_items := v_items || coalesce((select jsonb_agg(jsonb_build_object(
            'k', 'ott:' || v_period || ':' || substr(md5(t.team), 1, 8) || ':' || coalesce(to_char(v_last, 'YYYYMMDDHH24MISS'), '0'), 'kind', 'overtime_team',
            'at', coalesce(v_last, v_period::timestamptz), 'acked', false))
          from (select distinct coalesce(m->>'team', '') team from jsonb_array_elements(v_ot->'members') m) t), '[]'::jsonb);
      end if;
    end if;
  end if;

  -- 確認した印（締め日以外は home_acks を見る）
  v_items := (select coalesce(jsonb_agg(case
      when (i->>'kind') = 'payroll' then i
      else jsonb_set(i, '{acked}', to_jsonb(coalesce((i->>'acked')::boolean, false)
                       or exists (select 1 from home_acks h where h.user_id = v_uid and h.item_key = i->>'k'))) end), '[]'::jsonb)
    from jsonb_array_elements(v_items) i);

  return jsonb_build_object('seen_at', v_seen, 'items', v_items);
end;
$function$;
