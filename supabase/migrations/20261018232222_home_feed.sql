-- ホームの新着（2026-10-18・計画と決まったこと docs/計画-ホームの新着.md・2体のレビュー済み）
-- ・my_home_feed()：今ホームに出ているお知らせの「印（key）・種類・届いた時刻・確認したか」だけを返す（本文は返さない）。
--   ナビの 🏠 の赤い数字＝ホームを最後に見た時刻（profiles.home_seen_at）より後に届いたものの数（画面で数える）
-- ・home_mark_seen()：ホームを開いたら最後に見た時刻を今にする（前の時刻を返す＝画面が「新着」の印に使う）
-- ・home_ack(key)：［確認した］の記録（home_acks・1人×1お知らせで1行・1年で掃除）
-- 🚨 判定は帯（画面）と同じにしている。帯の判定を直すときはここも直す：
--   安否確認（App.tsx SafetyCheckBanner・公開設定 safety_check）／締め日（my_payroll_close_notice をそのまま呼ぶ）／
--   管理者からのお知らせ（lib/announcements の期間・再掲の期間＝ remind_in_app・ends_at・remind_days_before・JST の日付）／
--   催促（同じリマインドは最新の配信の1行・「後で」の期限内は出さない）／有休奨励日（対象で未回答・期限切れも出す）／
--   出勤のお願い（パートだけ・未回答で決まっていない・今日以降）／残業の目安超え（overtime_threshold_banner をそのまま呼ぶ・残業の権限か管理者）
-- 🚨 退職者は締め日だけ（画面と同じ）。打刻の確認・調整の提案・再提出の依頼の帯は数えない（ベルと2重になるため・2026-10-18 ユーザー確定）
-- 🚨 security definer：締め日・出勤のお願い・残業は、本人が直接読めない表を使うため。どの読み方も auth.uid() で本人に絞る

begin;

alter table public.profiles add column if not exists home_seen_at timestamptz;
comment on column public.profiles.home_seen_at is 'ホームを最後に見た時刻（2026-10-18・🏠 の新着の数字の基準）。書くのは home_mark_seen だけ';
-- 🚨 入れた時点で全員「今見た」ことにする（入れた直後に、今出ているお知らせで全員に数字が付かないように）
update public.profiles set home_seen_at = now() where home_seen_at is null;

create table if not exists public.home_acks (
  user_id  uuid not null references auth.users(id) on delete cascade,
  item_key text not null,
  acked_at timestamptz not null default now(),
  primary key (user_id, item_key)
);
comment on table public.home_acks is 'ホームのお知らせの［確認した］の記録（2026-10-18）。書くのは home_ack だけ。1年より前は毎晩消す';
alter table public.home_acks enable row level security;
drop policy if exists home_acks_select_own on public.home_acks;
create policy home_acks_select_own on public.home_acks for select to authenticated using (user_id = auth.uid());
revoke insert, update, delete on public.home_acks from anon, authenticated;

create or replace function public.my_home_feed()
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
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
revoke execute on function public.my_home_feed() from public;
revoke execute on function public.my_home_feed() from anon;
grant execute on function public.my_home_feed() to authenticated;
grant execute on function public.my_home_feed() to retiree;

-- ホームを開いた：最後に見た時刻を今に。前の時刻を返す（画面が「新着」の印を付けるため）
create or replace function public.home_mark_seen()
returns timestamptz
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_prev timestamptz;
begin
  if auth.uid() is null then raise exception 'HOME_AUTH: ログインしてください' using errcode = '42501'; end if;
  select home_seen_at into v_prev from profiles where id = auth.uid();
  update profiles set home_seen_at = now() where id = auth.uid();
  return v_prev;
end;
$function$;
revoke execute on function public.home_mark_seen() from public;
revoke execute on function public.home_mark_seen() from anon;
grant execute on function public.home_mark_seen() to authenticated;
grant execute on function public.home_mark_seen() to retiree;

-- ［確認した］の記録。印の形だけ確かめる（何の印かは my_home_feed が決める）
create or replace function public.home_ack(p_key text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is null then raise exception 'HOME_AUTH: ログインしてください' using errcode = '42501'; end if;
  if p_key is null or p_key !~ '^(ann|ots|ott|safe|rem|enc|part):[A-Za-z0-9:_.+-]{1,200}$' then
    raise exception 'HOME_BAD_KEY: 印の形が正しくありません' using errcode = '22023';
  end if;
  insert into home_acks (user_id, item_key) values (auth.uid(), p_key) on conflict (user_id, item_key) do nothing;
end;
$function$;
revoke execute on function public.home_ack(text) from public;
revoke execute on function public.home_ack(text) from anon;
grant execute on function public.home_ack(text) to authenticated;

-- 掃除：［確認した］の記録は1年（400日）で消す（毎晩 4:20 JST）
select cron.unschedule(jobid) from cron.job where jobname = 'purge-home-acks';
select cron.schedule('purge-home-acks', '20 19 * * *', $cron$delete from public.home_acks where acked_at < now() - interval '400 days'$cron$);

commit;
