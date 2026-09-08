-- 連絡板：グループのメンバー編集を「グループを作れる人」にも開放する（2026-09-08 ユーザー指示）
--
-- 背景：メンバーの追加・削除は管理者しかできなかった。役職が変わったときの追加もあるので、
--       「グループを作れる人」（管理画面 → 連絡板 で選んだ人）にも編集させる。
--
-- 🚨 判定は board_can_manage_groups() の1か所だけ。画面（BoardPage の canCreateGroup）も
--    RLS（board_channel_members の delete）もこの関数を呼ぶ。同じ条件を2か所に書かない。
--    「作れる人」の決まり（管理者は常に可／設定で選ばれた人／誰も選ばれていなければ
--    お知らせ自動CCの代表者と同じ人）は、これまで画面にだけあったものをそのまま移した。
--
-- 🚨 グループそのものの削除（board_channels の delete）は今までどおり管理者だけ。
--    ここでは触らない。

create or replace function public.board_can_manage_groups()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_admin()
      or exists (
           select 1
           from public.app_settings s
           cross join lateral jsonb_array_elements_text(s.value) as v(id)
           where s.key = 'board_group_create_user_ids'
             and jsonb_typeof(s.value) = 'array'
             and v.id = auth.uid()::text
         )
      or (
           -- 誰も選ばれていない（設定が無い／空）ときだけ、お知らせ自動CCの代表者と同じ人
           not exists (
             select 1 from public.app_settings s
             where s.key = 'board_group_create_user_ids'
               and jsonb_typeof(s.value) = 'array'
               and jsonb_array_length(s.value) > 0
           )
           and exists (
             select 1
             from public.app_settings s
             cross join lateral jsonb_array_elements_text(s.value) as v(id)
             where s.key = 'board_notice_cc_user_ids'
               and jsonb_typeof(s.value) = 'array'
               and v.id = auth.uid()::text
           )
         );
$$;

comment on function public.board_can_manage_groups() is
  '連絡板のグループを作成・メンバー編集できるか。管理者／設定で選ばれた人／（誰も選ばれていなければ）お知らせ自動CCの代表者。画面とRLSの両方がこれを呼ぶ';

-- 🚨 Supabase は新しい関数に anon の実行権限を自動で付ける。from public だけでは外れない
revoke execute on function public.board_can_manage_groups() from public;
revoke execute on function public.board_can_manage_groups() from anon;
grant  execute on function public.board_can_manage_groups() to authenticated;

-- メンバーの削除：これまでは「管理者 or 自分の行」だけ。「グループを作れる人」を足す。
-- （追加 insert は元から全員可なので触らない）
drop policy if exists board_members_delete on public.board_channel_members;
create policy board_members_delete on public.board_channel_members
  for delete to authenticated
  using (
    user_id = auth.uid()
    or public.board_can_manage_groups()
  );

-- ─────────────────────────────────────────────────────────────
-- 名簿の修正（2026-09-08 ユーザー確定・案③）
-- 山本 香澄さん（リーダー）が「マネージャー・リーダー」の名簿（profiles.group_names）にも
-- 会話のチャンネル（board_channel_members）にも入っていなかった。
-- 6/13 の一括作成のあとに誰も足していなかったため。両方に足す。
-- ─────────────────────────────────────────────────────────────
update public.profiles
   set group_names = array_append(coalesce(group_names, '{}'), 'マネージャー・リーダー')
 where id = '1573ca5d-76a3-48df-9731-ac2e7b35c392'   -- 山本 香澄
   and not (coalesce(group_names, '{}') @> array['マネージャー・リーダー']);

insert into public.board_channel_members (channel_id, user_id)
select '1d41cee1-cf79-4c4b-8409-8929b1128eaa',        -- グループ「マネージャー・リーダー」
       '1573ca5d-76a3-48df-9731-ac2e7b35c392'         -- 山本 香澄
 where not exists (
   select 1 from public.board_channel_members
    where channel_id = '1d41cee1-cf79-4c4b-8409-8929b1128eaa'
      and user_id    = '1573ca5d-76a3-48df-9731-ac2e7b35c392'
 );
