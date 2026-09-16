-- 連絡板：お知らせの「宛先」を、送信者本人と写し（CC）の代表者も読めるようにする（2026-09-16 ユーザー承認）
--
-- 背景：board_message_recipients（誰あてに送ったかの表）を読めるのは
--       「管理者」「自分あての行」「同じお知らせを受け取った人」の3つだけだった。
--       🚨 **送った本人が、自分の送り先を確認できない**（自分が宛先に入っていない場合）。
--       写し（CC）で共有された代表者も同じく読めない。
--       そのため送信トレイの宛先が「0人」と表示され、既読・未読も「0」になっていた
--       （2026-09-16 実測。林さんの画面で、自分が宛先に入っている9/8のお知らせだけ
--         正しく6人と出て、ほかは全部0人だった）。
--
-- 🚨 既存の4つのポリシーは触らない。1本足すだけ（PERMISSIVE なので OR される）。
--
-- 🚨 ポリシーから board_messages を直接参照しない。
--    board_messages 側のポリシーが board_message_recipients を参照しているため、
--    直接書くと RLS が相互参照して無限再帰になる。
--    既存の get_my_recipient_message_ids() と同じく **security definer の関数**にして避ける。
--
-- 🚨 代表者かどうかの判定は board_is_notice_cc_rep()（2026-09-16 作成）を呼ぶ。
--    同じ判定を2か所に書かない。

create or replace function public.board_can_see_recipients(p_message_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.board_messages m
    where m.id = p_message_id
      and (
        -- 送った本人
        m.user_id = auth.uid()
        -- 写し（CC）に入っている代表者
        or (
          m.cc_user_ids is not null
          and auth.uid()::text = any (m.cc_user_ids)
          and public.board_is_notice_cc_rep()
        )
      )
  );
$$;

comment on function public.board_can_see_recipients(uuid) is
  'そのお知らせの宛先一覧を見てよいか（送った本人／写しに入っている代表者）。board_message_recipients の select ポリシーが呼ぶ。RLS の相互参照を避けるため security definer';

-- 🚨 Supabase は新しい関数に anon の実行権限を自動で付ける。from public だけでは外れない
revoke execute on function public.board_can_see_recipients(uuid) from public;
revoke execute on function public.board_can_see_recipients(uuid) from anon;
grant  execute on function public.board_can_see_recipients(uuid) to authenticated;

drop policy if exists board_recipients_select_sender_cc on public.board_message_recipients;
create policy board_recipients_select_sender_cc on public.board_message_recipients
for select to authenticated
using (public.board_can_see_recipients(message_id));
