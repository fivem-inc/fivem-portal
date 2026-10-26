-- 連絡板の「送信の取り消し」（Gmail と同じ・2026-10-26 ユーザー確定）と、送り方を1か所にまとめる
-- 計画とレビューで決まったことの全部：docs/計画-連絡板の送信の取り消し.md
--
-- ■ 流れ
--   ［送信］→ board_post（本体・宛先・写しを1つの取引で作る。status='scheduled'・send_hold=true・scheduled_at＝今＋10秒＝サーバーの時計）
--   → 10秒たったら画面が board_release_hold（今すぐ届ける）。画面を閉じていても毎分のジョブが拾う（遅れは最大1分ほど）
--   →［取り消す］は board_cancel_hold（本人・send_hold・まだ届いていない行だけ消す。消せたかどうかを返す）
--   急ぎ・安否確認は board_post の p_hold=false でその場で届ける（取り消しなし）
--   自分で決めた送信予約は send_hold=false のまま scheduled_at に毎分のジョブが届ける
--
-- ■ 「届ける」（board_deliver）を1か所に。送信済みにするのと同じ取引で、宛先を決めてベルを入れ、メールを積む。
--   ベルの文は画面（BoardPage.tsx）が今まで入れていた文と同じ。🚨 送った本人には送らない
--   メールは board_email_queue に積み、Edge Function board-scheduled-send がまとめて送る（.invalid は除く）
--
-- ■ 一緒に直す穴（本番とコードで確認済み）
--   ・グループ・DM の送信予約が、送った瞬間にベル・スマホ・メールを出していた → 予約の時刻に届ける
--   ・予約で送るお知らせは、送った本人にもベル・メールが届いていた → 本人を除く
--   ・送信済みにしてからベルを作っていた（途中で落ちると届かない） → 同じ取引
--   ・ナビの数（my_board_unread）のグループ・返信の数え方が、予約中（未送信）の投稿も数えていた
--   ・読む権限が status を見ず、予約中の投稿を宛先の人が API から読めた → 送った本人・管理者・写しの代表者だけ
--   ・宛先の行（board_message_recipients）を、だれでもどのお知らせにも足せた → 送った本人（と管理者）だけ
--   ・スレッドに返信するたび、グループ全員にメールが行っていた → スレッドに参加している人だけ（2026-10-26 ユーザー確定）
--
-- 🚨 古い画面（まだ読み込み直していない端末）も今までどおり動く：insert で status='sent' を直接入れる送り方は止めていない
-- 🚨 共用の毎分のジョブ push-dispatch-every-min に相乗りする（中身は cron_every_minute。push-dispatch の呼び方は今までと同じ条件）。場所予約の担当に連絡する

-- ─────────────────────────────────────────────
-- 1. 列
-- ─────────────────────────────────────────────
alter table public.board_messages
  add column if not exists send_hold   boolean not null default false,
  add column if not exists push_urgent boolean not null default false,
  add column if not exists send_batch  uuid;
comment on column public.board_messages.send_hold   is '取り消し待ち（［送信］のあと10秒・利用者が選んだ送信予約ではない）。届けたら false';
comment on column public.board_messages.push_urgent is '「⚡当日の連絡・緊急」。届けるときのベルに写す（受信時間の設定を無視してすぐプッシュ）';
comment on column public.board_messages.send_batch  is 'DM の一斉送信をまとめて取り消す・届けるための番号（一斉の DM は今までどおりメールを送らない）';

create index if not exists board_messages_scheduled_due_idx
  on public.board_messages (scheduled_at) where status = 'scheduled';
create index if not exists board_messages_send_batch_idx
  on public.board_messages (send_batch) where send_batch is not null;

-- ─────────────────────────────────────────────
-- 2. メールの送信待ち（画面からは読めない・書けない）
-- ─────────────────────────────────────────────
create table if not exists public.board_email_queue (
  id          uuid primary key default gen_random_uuid(),
  message_id  uuid,
  event_key   text not null,
  user_ids    uuid[] not null,
  vars        jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  claimed_at  timestamptz,
  attempts    integer not null default 0,
  sent_at     timestamptz,
  error       text
);
alter table public.board_email_queue enable row level security;
revoke all on public.board_email_queue from anon, authenticated;
grant all on public.board_email_queue to service_role;
create index if not exists board_email_queue_pending_idx on public.board_email_queue (created_at) where sent_at is null;
comment on table public.board_email_queue is '連絡板のメールの送信待ち（board_deliver が積み、Edge Function board-scheduled-send が送る・30日で消す）';

-- ─────────────────────────────────────────────
-- 3. 届けたときのベルとメール（1件ぶん）
-- ─────────────────────────────────────────────
create or replace function public.board_notify_delivered(m public.board_messages)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_sender  text;
  v_ch      public.board_channels;
  v_users   uuid[];
  v_preview text := left(btrim(m.body), 40);
  v_link    constant text := 'https://fivem-portal.vercel.app/board';
  v_chname  text;
begin
  select coalesce(nullif(btrim(p.name), ''), '誰か') into v_sender from profiles p where p.id = m.user_id;
  v_sender := coalesce(v_sender, '誰か');

  if m.channel_id is null and m.parent_id is null then
    -- お知らせ
    select array_agg(distinct r.user_id) into v_users
      from board_message_recipients r where r.message_id = m.id and r.user_id <> m.user_id;
    if v_users is null then return; end if;
    insert into notifications (user_id, message, sub_message, reference_id, event_key, push_urgent, created_by)
    select u, '💬 ' || v_sender || 'からお知らせが届きました',
           left(coalesce(nullif(btrim(m.subject), ''), btrim(m.body)), 40),
           m.id::text, 'board:notice', m.push_urgent, m.user_id
      from unnest(v_users) u;
    insert into board_email_queue (message_id, event_key, user_ids, vars)
    values (m.id, 'board:notice', v_users,
            jsonb_build_object('送信者名', v_sender, '件名', coalesce(btrim(m.subject), ''), 'リンク', v_link || '?openInboxId=' || m.id));
    return;
  end if;

  if m.channel_id is null then
    -- お知らせへの返信（相手は宛先の行の1人）。メールは今までどおり送らない
    select array_agg(distinct r.user_id) into v_users
      from board_message_recipients r where r.message_id = m.id and r.user_id <> m.user_id;
    if v_users is null then return; end if;
    insert into notifications (user_id, message, sub_message, reference_id, event_key, push_urgent, created_by)
    select u, '↩ ' || v_sender || 'から返信が届きました', v_preview,
           m.parent_id::text, 'board:dm_message:reply', m.push_urgent, m.user_id
      from unnest(v_users) u;
    return;
  end if;

  select * into v_ch from board_channels c where c.id = m.channel_id;
  if not found or v_ch.type not in ('group', 'dm') then return; end if;   -- 送信メール（sent_mail）の記録は知らせない

  if m.parent_id is null then
    -- グループ・DM への投稿
    select array_agg(distinct mb.user_id) into v_users
      from board_channel_members mb where mb.channel_id = m.channel_id and mb.user_id <> m.user_id;
    if v_users is null then return; end if;
    insert into notifications (user_id, message, sub_message, reference_id, event_key, push_urgent, created_by)
    select u,
           case when v_ch.type = 'group'
                then '💬 ' || coalesce(nullif(v_ch.name, ''), 'グループ') || 'に' || v_sender || 'からメッセージが届きました'
                else '💬 ' || v_sender || 'からメッセージが届きました' end,
           v_preview, m.id::text,
           case when v_ch.type = 'group' then 'board:group_message' else 'board:dm_message' end,
           m.push_urgent, m.user_id
      from unnest(v_users) u;
    if v_ch.type = 'group' then
      insert into board_email_queue (message_id, event_key, user_ids, vars)
      values (m.id, 'board:group_message', v_users,
              jsonb_build_object('送信者名', v_sender, 'グループ名', coalesce(nullif(v_ch.name, ''), 'グループ'), 'リンク', v_link));
    elsif m.send_batch is null then
      -- 🚨 一斉の DM（send_batch あり）は今までどおりメールを送らない
      insert into board_email_queue (message_id, event_key, user_ids, vars)
      values (m.id, 'board:dm_message', v_users, jsonb_build_object('送信者名', v_sender, 'リンク', v_link));
    end if;
    return;
  end if;

  -- スレッドへの返信：元の投稿の人＋そのスレッドに返信した人（送った本人を除く）
  select array_agg(distinct x.uid) into v_users from (
    select p.user_id as uid from board_messages p where p.id = m.parent_id
    union
    select q.user_id from board_messages q where q.parent_id = m.parent_id and q.status = 'sent'
  ) x where x.uid <> m.user_id;
  if v_users is null then return; end if;
  v_chname := coalesce(nullif(v_ch.name, ''), 'チャンネル');
  insert into notifications (user_id, message, sub_message, reference_id, event_key, push_urgent, created_by)
  select u, '💬 ' || v_sender || 'がスレッドにリプライしました', v_chname || ': ' || v_preview,
         m.parent_id::text, 'board:group_message', m.push_urgent, m.user_id
    from unnest(v_users) u;
  -- 🚨 メールはスレッドに参加している人だけ（2026-10-26 ユーザー確定・前はグループ全員）
  if v_ch.type = 'group' then
    insert into board_email_queue (message_id, event_key, user_ids, vars)
    values (m.id, 'board:group_message', v_users,
            jsonb_build_object('送信者名', v_sender, 'グループ名', coalesce(nullif(v_ch.name, ''), 'グループ'), 'リンク', v_link));
  else
    insert into board_email_queue (message_id, event_key, user_ids, vars)
    values (m.id, 'board:dm_message', v_users, jsonb_build_object('送信者名', v_sender, 'リンク', v_link));
  end if;
end;
$$;

-- ─────────────────────────────────────────────
-- 4. 届ける（送信済みにする＋ベル＋メールを1つの取引で）。中だけで使う
-- ─────────────────────────────────────────────
create or replace function public.board_deliver(p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  m   public.board_messages;
  v_n integer := 0;
begin
  if p_ids is null or cardinality(p_ids) = 0 then return 0; end if;
  -- 🚨 status='scheduled' の行だけ。取り消し（削除）・ほかの届け（毎分のジョブと画面）と同時でも、行の鍵で1回だけになる
  for m in
    update board_messages
       set status = 'sent',
           sent_at = now(),
           send_hold = false,
           -- 取り消し待ちだった行は「予約」ではないので、送信予約の時刻を残さない（送信トレイに「◯時に送信予定」と出さない）
           scheduled_at = case when send_hold then null else scheduled_at end
     where id = any(p_ids) and status = 'scheduled'
    returning *
  loop
    perform board_notify_delivered(m);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- メールの送信待ちがあれば Edge Function を呼ぶ（pg_net は取引が確定してから送る）
create or replace function public.board_kick_email()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from board_email_queue q
              where q.sent_at is null and q.attempts < 3
                and (q.claimed_at is null or q.claimed_at < now() - interval '10 minutes')) then
    perform cron_call_edge('board-scheduled-send');
  end if;
end;
$$;

-- 時刻の来た予約・取り消し待ちを届ける（毎分のジョブから）
create or replace function public.board_deliver_due()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
begin
  select array_agg(id) into v_ids from (
    select id from board_messages
     where status = 'scheduled' and scheduled_at <= now()
     order by scheduled_at limit 200
  ) x;
  return board_deliver(v_ids);
end;
$$;

-- ─────────────────────────────────────────────
-- 5. 送る（画面から）。本体・宛先・写しを1つの取引で作る
-- ─────────────────────────────────────────────
-- p_id     … 端末で作る番号（押し直し・通信の切れたあとの送り直しでも2件にならない）
-- p_msg    … board_messages の列（channel_id・parent_id・body・subject・title・deadline・deadline_type・requires_confirmation・
--             scheduled_at（自分で決めた送信予約）・answer_*・allow_reply・cc_user_ids・recipient_presets・recipient_extra_ids・
--             broadcast_recipients・push_urgent）。user_id・status・send_hold は受け取らない
-- p_recipients … お知らせの宛先／お知らせへの返信の相手（1人）
-- p_hold   … true＝10秒の取り消し待ち。false＝その場で届ける（急ぎ・安否確認）
-- p_batch  … DM の一斉送信の番号
-- 返り値：{ id, state: 'held' | 'scheduled' | 'sent', scheduled_at, existed }
create or replace function public.board_post(
  p_id uuid, p_msg jsonb, p_recipients uuid[] default null, p_hold boolean default true, p_batch uuid default null)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_uid   uuid := auth.uid();
  r       public.board_messages;
  v_ex    public.board_messages;
  v_sched timestamptz;
  v_n     integer;
begin
  if v_uid is null then raise exception 'ログインが必要です' using errcode = '42501'; end if;
  if p_id is null then raise exception '送る番号がありません' using errcode = '22023'; end if;

  -- 同じ番号がもうある＝押し直し・送り直し。今の状態を返すだけ（2件にしない）
  select * into v_ex from board_messages where id = p_id;
  if found then
    if v_ex.user_id <> v_uid then raise exception 'この番号は使えません' using errcode = '42501'; end if;
    return jsonb_build_object('id', v_ex.id,
      'state', case when v_ex.status = 'sent' then 'sent' when v_ex.send_hold then 'held' else 'scheduled' end,
      'scheduled_at', v_ex.scheduled_at, 'existed', true);
  end if;

  r := jsonb_populate_record(null::public.board_messages, p_msg);
  if coalesce(btrim(r.body), '') = '' then raise exception '本文がありません' using errcode = '22023'; end if;
  v_sched := case when r.parent_id is null then r.scheduled_at else null end;   -- 返信は予約できない

  if r.channel_id is null and r.parent_id is null then
    if coalesce(btrim(r.subject), '') = '' then raise exception '件名がありません' using errcode = '22023'; end if;
    if coalesce(cardinality(p_recipients), 0) = 0 then raise exception '宛先がありません' using errcode = '22023'; end if;
  elsif r.channel_id is null then
    if coalesce(cardinality(p_recipients), 0) <> 1 then raise exception '返信の相手がありません' using errcode = '22023'; end if;
    if not board_reply_party(r.parent_id, p_recipients[1]) then
      raise exception '返信の相手が、このお知らせの関係者ではありません' using errcode = '42501';
    end if;
  end if;

  -- 🚨 読み書きの決まり（RLS）はそのまま効く（invoker）。送れない人・入っていないグループは止まる
  insert into board_messages (
    id, channel_id, parent_id, user_id, body, subject, title,
    deadline, deadline_type, requires_confirmation,
    answer_prompt, answer_location, answer_link, allow_reply,
    cc_user_ids, recipient_presets, recipient_extra_ids, broadcast_recipients,
    status, scheduled_at, send_hold, push_urgent, send_batch)
  values (
    p_id, r.channel_id, r.parent_id, v_uid, btrim(r.body), nullif(btrim(r.subject), ''), nullif(btrim(r.title), ''),
    r.deadline, r.deadline_type, coalesce(r.requires_confirmation, false),
    r.answer_prompt, r.answer_location, r.answer_link, coalesce(r.allow_reply, false),
    coalesce(r.cc_user_ids, '{}'::text[]), r.recipient_presets, r.recipient_extra_ids, r.broadcast_recipients,
    'scheduled',
    case when v_sched is not null then v_sched
         when p_hold then clock_timestamp() + interval '10 seconds'
         else clock_timestamp() end,
    v_sched is null,
    coalesce(r.push_urgent, false),
    p_batch);

  if r.channel_id is null then
    insert into board_message_recipients (message_id, user_id)
    select p_id, u from (select distinct unnest(p_recipients) as u) x where u is not null;
  end if;

  if v_sched is not null then
    return jsonb_build_object('id', p_id, 'state', 'scheduled', 'scheduled_at', v_sched, 'existed', false);
  end if;
  if not p_hold then
    v_n := board_release_hold(p_id, null);
    return jsonb_build_object('id', p_id, 'state', case when v_n > 0 then 'sent' else 'held' end, 'scheduled_at', null, 'existed', false);
  end if;
  return jsonb_build_object('id', p_id, 'state', 'held',
    'scheduled_at', (select scheduled_at from board_messages where id = p_id), 'existed', false);
end;
$$;

-- 今すぐ届ける（10秒たったとき・一斉の残り）。本人の取り消し待ちだけ
create or replace function public.board_release_hold(p_id uuid default null, p_batch uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids uuid[];
  v_n   integer;
begin
  if auth.uid() is null then raise exception 'ログインが必要です' using errcode = '42501'; end if;
  select array_agg(id) into v_ids from board_messages
   where user_id = auth.uid() and send_hold and status = 'scheduled'
     and ((p_id is not null and id = p_id) or (p_batch is not null and send_batch = p_batch));
  v_n := board_deliver(v_ids);
  if v_n > 0 then perform board_kick_email(); end if;
  return v_n;
end;
$$;

-- 取り消す。返り値：'cancelled'（消せた）／'already_sent'（もう届いた）／'gone'（見つからない）
create or replace function public.board_cancel_hold(p_id uuid default null, p_batch uuid default null)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n integer;
begin
  if auth.uid() is null then raise exception 'ログインが必要です' using errcode = '42501'; end if;
  -- 🚨 本人・取り消し待ち・まだ届いていない行だけ。届けと同時なら行の鍵でどちらか一方だけになる
  delete from board_messages
   where user_id = auth.uid() and send_hold and status = 'scheduled'
     and ((p_id is not null and id = p_id) or (p_batch is not null and send_batch = p_batch));
  get diagnostics v_n = row_count;
  if v_n > 0 then return 'cancelled'; end if;
  if exists (select 1 from board_messages
              where user_id = auth.uid()
                and ((p_id is not null and id = p_id) or (p_batch is not null and send_batch = p_batch))) then
    return 'already_sent';
  end if;
  return 'gone';
end;
$$;

-- Edge Function がメールの送信待ちを受け取る（宛先のアドレスも返す・.invalid と空は除く）
create or replace function public.board_email_claim(p_limit integer default 50)
returns table (id uuid, event_key text, vars jsonb, emails text[])
language sql
security definer
set search_path = public
as $$
  with c as (
    select q.id from board_email_queue q
     where q.sent_at is null and q.attempts < 3
       and (q.claimed_at is null or q.claimed_at < now() - interval '10 minutes')
     order by q.created_at
     limit greatest(1, least(coalesce(p_limit, 50), 200))
     for update skip locked
  )
  update board_email_queue q
     set claimed_at = now(), attempts = q.attempts + 1
    from c
   where q.id = c.id
  returning q.id, q.event_key, q.vars,
    array(select p.email from profiles p
           where p.id = any(q.user_ids)
             and coalesce(p.email, '') <> ''
             and p.email not ilike '%.invalid');
$$;

-- 権限：画面から呼べるのは board_post・board_release_hold・board_cancel_hold だけ
do $$
declare f text;
begin
  foreach f in array array[
    'board_notify_delivered(public.board_messages)', 'board_deliver(uuid[])', 'board_kick_email()',
    'board_deliver_due()', 'board_email_claim(integer)'] loop
    execute format('revoke execute on function public.%s from public', f);
    execute format('revoke execute on function public.%s from anon', f);
    execute format('revoke execute on function public.%s from authenticated', f);
  end loop;
  foreach f in array array[
    'board_post(uuid, jsonb, uuid[], boolean, uuid)', 'board_release_hold(uuid, uuid)', 'board_cancel_hold(uuid, uuid)'] loop
    execute format('revoke execute on function public.%s from public', f);
    execute format('revoke execute on function public.%s from anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
grant execute on function public.board_email_claim(integer) to service_role;

-- ─────────────────────────────────────────────
-- 6. 読む権限：予約中（未送信）の投稿は、送った本人・管理者・写しの代表者だけ
--    （もとの条件は本番の実定義のまま。最後に status の条件を足しただけ）
-- ─────────────────────────────────────────────
drop policy if exists board_messages_select on public.board_messages;
create policy board_messages_select on public.board_messages
  for select to authenticated
  using (
    (
      ((channel_id IS NOT NULL) AND ((channel_id IN ( SELECT bcm.channel_id
         FROM board_channel_members bcm
        WHERE (bcm.user_id = auth.uid()))) OR (((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text)))
      OR ((channel_id IS NULL) AND ((user_id = auth.uid()) OR (id IN ( SELECT r.message_id
         FROM board_message_recipients r
        WHERE (r.user_id = auth.uid()))) OR (((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text)
        OR ((cc_user_ids IS NOT NULL) AND ((auth.uid())::text = ANY (cc_user_ids)) AND board_is_notice_cc_rep())))
    )
    AND (
      status <> 'scheduled'
      OR user_id = auth.uid()
      OR (((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text)
      OR ((channel_id IS NULL) AND (cc_user_ids IS NOT NULL) AND ((auth.uid())::text = ANY (cc_user_ids)) AND board_is_notice_cc_rep())
    )
  );

-- 宛先の行は、そのお知らせを送った本人（と管理者）だけが足せる（前はだれでも、どのお知らせにも足せた）
-- 🚨 board_messages の読む権限が宛先の表を見るので、ここで board_messages を直接読むと循環する（42P17）。definer の部品で見る
create or replace function public.board_is_my_message(p_message_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (select 1 from board_messages m where m.id = p_message_id and m.user_id = auth.uid());
$$;
revoke execute on function public.board_is_my_message(uuid) from public;
revoke execute on function public.board_is_my_message(uuid) from anon;
grant execute on function public.board_is_my_message(uuid) to authenticated;

drop policy if exists board_recipients_insert on public.board_message_recipients;
create policy board_recipients_insert on public.board_message_recipients
  for insert to authenticated
  with check (
    board_is_my_message(message_id)
    OR (((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text)
  );

-- ─────────────────────────────────────────────
-- 7. ナビの数（本番の実定義から。channel と rep に「送信済み」の条件を足しただけ）
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.my_board_unread()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  with me as (select auth.uid() as uid),
  inbox as (
    select r.message_id from board_message_recipients r
    where r.user_id = (select uid from me) and r.archived = false
  ),
  sent as (
    select m.id, (coalesce(m.requires_confirmation, false) or coalesce(m.deadline_type, '') <> '') as need
    from board_messages m
    where m.id in (select message_id from inbox) and m.parent_id is null and m.status = 'sent'
  ),
  rep as (
    select m.id from board_messages m
    where m.id in (select message_id from inbox) and m.parent_id is not null and m.channel_id is null
      and m.user_id <> (select uid from me)
      and m.status = 'sent'
  ),
  att as (
    select s.id from sent s
      where not exists (select 1 from board_reads b where b.user_id = (select uid from me) and b.message_id = s.id)
    union
    select s.id from sent s
      where s.need and not exists (select 1 from board_confirmations c where c.user_id = (select uid from me) and c.message_id = s.id)
    union
    select x.id from rep x
      where not exists (select 1 from board_reads b where b.user_id = (select uid from me) and b.message_id = x.id)
  )
  select jsonb_build_object(
    'channel', (
      select count(*) from board_messages m
      where m.channel_id in (select mb.channel_id from board_channel_members mb where mb.user_id = (select uid from me))
        and m.parent_id is null
        and m.user_id <> (select uid from me)
        and m.status = 'sent'
        and (m.scheduled_at is null or m.scheduled_at <= now())
        and not exists (select 1 from board_reads b where b.user_id = (select uid from me) and b.message_id = m.id)
    ),
    'inbox', (select count(*) from att)
  );
$function$;

-- ─────────────────────────────────────────────
-- 8. 毎分のジョブ（共用の push-dispatch-every-min に相乗り）
-- ─────────────────────────────────────────────
-- 🚨 push-dispatch を呼ぶ条件は今までと同じ（push_queue か push_deferred に pending があるとき）。
--    連絡板の届けを先にするので、届けたベルのスマホの通知も同じ回で送られる。連絡板の部分で失敗しても push-dispatch は止めない
create or replace function public.cron_every_minute()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    perform board_deliver_due();
    perform board_kick_email();
  exception when others then
    raise warning '[cron_every_minute] 連絡板の届けに失敗: %', sqlerrm;
  end;
  if exists (select 1 from push_queue where status = 'pending')
     or exists (select 1 from push_deferred where status = 'pending') then
    perform cron_call_edge('push-dispatch');
  end if;
end;
$$;
revoke execute on function public.cron_every_minute() from public;
revoke execute on function public.cron_every_minute() from anon;
revoke execute on function public.cron_every_minute() from authenticated;

select cron.alter_job(job_id := (select jobid from cron.job where jobname = 'push-dispatch-every-min'),
                      command := 'select public.cron_every_minute()');
-- 5分ごとの予約送信のジョブは毎分のジョブに入れたので止める（関数 cron_board_scheduled_send は戻すときのために残す）
select cron.unschedule('board-scheduled-send-every-5-min');

-- メールの送信待ちの片付け（30日・毎日 3:55 JST）
select cron.schedule('purge-board-email-queue', '55 18 * * *',
  $c$delete from public.board_email_queue where created_at < now() - interval '30 days'$c$);

-- 戻すとき：
--  ・push-dispatch-every-min の command を元に戻す（20261018174048 の形：net.http_post … where exists push_queue / push_deferred の pending）
--  ・select cron.schedule('board-scheduled-send-every-5-min', '*/5 * * * *', 'select public.cron_board_scheduled_send()');
--  ・Edge Function board-scheduled-send を前の版に（git の 20261026 より前）
