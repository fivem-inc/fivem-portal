-- 連絡板のお知らせ：送った本人が自分を宛先に選んでいたら、本人にもベル・スマホ・メールを届ける（2026-10-26 ユーザー確定「自分を選んでるなら それでよい」）
-- ・20261026193037 の board_notify_delivered（本番の実定義＝そのファイルと同じ）のお知らせの枝だけ、宛先から本人を外す条件を消した
-- ・グループ・DM・返信は今までどおり本人には送らない（自分で宛先を選ぶものではないため）

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
      from board_message_recipients r where r.message_id = m.id;  -- 🚨 お知らせは、送った本人も宛先に選んでいれば届ける（2026-10-26 ユーザー確定）
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
