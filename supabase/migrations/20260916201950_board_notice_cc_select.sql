-- 連絡板：お知らせの「写し（CC）」を、代表者が送信トレイで読めるようにする（2026-09-16 ユーザー承認）
--
-- 背景：お知らせの送信画面に「他の代表者の送信履歴に加える」というチェックがある。
--       入れると board_messages.cc_user_ids に代表者（app_settings の
--       'board_notice_cc_user_ids'）が入り、その人の送信トレイに写しが出る作りだった。
--       🚨 ところが board_messages の読み取り権限は「送信者本人 / 宛先 / 管理者」しか見ておらず、
--          cc_user_ids を見ていなかった。そのため宛先に入っていない代表者は写しを読めず、
--          送信トレイに何も出ていなかった。
--          代表者4人のうち app_metadata.role='admin' は「管理者」アカウントだけで、
--          社長・マネージャーは管理者ではない（2026-09-16 実測）。
--          ＝この機能は実質「管理者」アカウントにしか効いていなかった。
--
-- 🚨 cc_user_ids は uuid[] ではなく **text[]**（2026-09-16 実測）。
--    auth.uid() は uuid なので ::text を付けないと型エラーになる。
--
-- 🚨 「写しに入れれば誰でも読める」形にはしない。
--    「cc_user_ids に自分がいる」かつ「いま代表者の設定に入っている」の両方を求める。
--    設定から外れた人が、過去の写しを読み続けることもなくなる。
--
-- 🚨 更新（outbox_hidden＝送信トレイのアーカイブ）は今までどおり送信者本人と管理者だけ。
--    写しの人にも許すと、代表者が片付けたときに送信者本人の送信トレイからも消える
--    （1つの行を共有しているため）。ここは意図的に触らない。

create or replace function public.board_is_notice_cc_rep()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.app_settings s
    cross join lateral jsonb_array_elements_text(s.value) as v(id)
    where s.key = 'board_notice_cc_user_ids'
      and jsonb_typeof(s.value) = 'array'
      and v.id = auth.uid()::text
  );
$$;

comment on function public.board_is_notice_cc_rep() is
  'いまログインしている人が、お知らせの写し（CC）を受け取る代表者かどうか。board_messages の select ポリシーが呼ぶ';

-- 🚨 Supabase は新しい関数に anon の実行権限を自動で付ける。from public だけでは外れない
revoke execute on function public.board_is_notice_cc_rep() from public;
revoke execute on function public.board_is_notice_cc_rep() from anon;
grant  execute on function public.board_is_notice_cc_rep() to authenticated;

-- 🚨 本番の実定義（pg_policies の qual）から起こしたもの。
--    変えたのは channel_id is null の枝に or を1つ足した点だけ。
drop policy if exists board_messages_select on public.board_messages;
create policy board_messages_select on public.board_messages
for select to authenticated
using (
  (
    channel_id is not null
    and (
      channel_id in (
        select bcm.channel_id from public.board_channel_members bcm where bcm.user_id = auth.uid()
      )
      or ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
    )
  )
  or (
    channel_id is null
    and (
      user_id = auth.uid()
      or id in (
        select r.message_id from public.board_message_recipients r where r.user_id = auth.uid()
      )
      or ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
      -- ここだけが今回の追加：写し（CC）に入っている代表者も読める
      or (
        cc_user_ids is not null
        and auth.uid()::text = any (cc_user_ids)
        and public.board_is_notice_cc_rep()
      )
    )
  )
);
