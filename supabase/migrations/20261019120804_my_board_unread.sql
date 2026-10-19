-- 連絡板の未読の数を DB の関数1本で数える（2026-10-19・通信量の見直しの残り・ユーザー「順に進めて」）
-- ・前は画面（App.tsx の useBoardUnread）が最大7本の問い合わせで数えていた。
--   グループのメッセージは届いたもの全部の id を毎回読み、board_reads を .in() で引いていた（件数が増えると 1,000件で黙って打ち切られる）
-- ・数え方は画面と同じ（変えていない）：
--   channel ＝ 自分が入っているグループの、自分以外が書いた親メッセージのうち board_reads に自分の行が無いもの
--   inbox   ＝ 受信トレイ（archived=false）の「未読 または 未対応」の集合（足し算しない）
--             お知らせ本体（親・status='sent'）の未読／読了報告・回答が要るのに board_confirmations に自分の行が無いもの／
--             お知らせへの返信（親あり・channel_id 空・自分以外）の未読
-- 🚨 security invoker（RLS は画面から読むときと同じ）。退職者は画面が呼ばない（enabled=false）
-- 🚨 anon からは外す

begin;

create or replace function public.my_board_unread()
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
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
        and not exists (select 1 from board_reads b where b.user_id = (select uid from me) and b.message_id = m.id)
    ),
    'inbox', (select count(*) from att)
  );
$$;

revoke execute on function public.my_board_unread() from public;
revoke execute on function public.my_board_unread() from anon;
grant execute on function public.my_board_unread() to authenticated;

commit;
