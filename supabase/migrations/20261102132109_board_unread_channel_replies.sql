-- 連絡板：グループ・DM のコメントへの返信（スレッドの返信）も、ナビの連絡板の数字に入れる（2026-11-02 ユーザー確定）
--
-- これまで：'channel' の数はグループ・DM の新しい投稿（parent_id が空）だけ。返信は投稿の下の小さな字にしか出ず、ナビにも一覧にも数字が無かった
-- これから：その人がそのグループ・DM を最後に開いた時刻（board_channel_last_seen）より後の、ほかの方の返信も数える
--   ・画面のグループの一覧の数字（BoardPage の channelUnread）と同じ決まり。グループを開けば0に戻る
--   ・既読の記録（board_reads）は増やさない（返信1件ごとに行を書かない）
--   ・入れる前の本番の数：返信の未読は1人1件だけ（急に数字が増える方はいない）
-- 🚨 本番の実定義（2026-11-02 に pg_get_functiondef で取得・20261026193037 と同じ）から、'channel' の数に返信の分を足しただけ。'inbox' は変えていない
-- 🚨 戻すときは 20261026193037_board_send_undo.sql の my_board_unread をそのまま流す

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
    ) + (
      -- グループ・DM のコメントへの返信（最後に開いた時刻より後・ほかの方の分）
      select count(*) from board_messages m
      join board_channel_members mb on mb.channel_id = m.channel_id and mb.user_id = (select uid from me)
      left join board_channel_last_seen ls on ls.channel_id = m.channel_id and ls.user_id = (select uid from me)
      where m.parent_id is not null
        and m.user_id <> (select uid from me)
        and m.status = 'sent'
        and m.created_at > coalesce(ls.last_seen_at, '-infinity'::timestamptz)
    ),
    'inbox', (select count(*) from att)
  );
$function$;

-- 権限は今までどおり（create or replace は権限を変えない）。念のため anon は外したまま
revoke execute on function public.my_board_unread() from anon;
