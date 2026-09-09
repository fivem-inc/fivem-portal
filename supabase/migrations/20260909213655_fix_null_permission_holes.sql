-- 🚨🚨 権限判定が NULL になって素通りする穴を塞ぐ（2026-09-09・総合チェックで実測）
--
-- 【何が起きていたか】
--   (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
--       ↑ app_metadata を持たない人（管理者以外のほぼ全員）では **NULL** になる。
--   🚨 = で比べていても、or / and と組み合わせると式全体が NULL に汚染される：
--         NULL or false = NULL  →  not NULL = NULL  →  if が成立せず素通り
--
--   実測（rollback 済み）：set_leave_request_enabled を
--   **未ログインでも一般スタッフでも呼べてしまい、実際に値が書き換わった**。
--   これは「定義を読んだ限りでは安全に見えた」もので、
--   🚨 **実際に呼んで初めて分かった**。読んだだけで安全と判断しないこと。
--
-- 【直し方】
--   判定を is_admin() に置き換える。is_admin() は中で coalesce しており NULL を返さない。
--   さらに、boolean を返す関数は全体を coalesce で包み、**NULL を返さない**ようにする。
--   （NULL を返す関数が残っていると、次にそれを使う人が同じ穴を作る）
--
-- 🚨 定義は**本番の pg_get_functiondef から起こした**。
--    変更したのは権限判定の部分だけで、処理の中身は変えていない。

-- ========================================
-- 1) 🚨 実際に素通りしていたもの（書き込みを伴う）
--    休暇申請フォームを送れるようにする権限。未ログインの人でも書き換えられた。
-- ========================================
create or replace function public.set_leave_request_enabled(p_user_id uuid, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- 🚨 is_admin() を使う（coalesce 済みで NULL を返さない）。
  --    exists も NULL を返さないので、or で組み合わせても汚染されない。
  if not (
    is_admin()
    or exists (
      select 1 from profiles
      where id = auth.uid()
        and role_title = any (array['リーダー', 'マネージャー', '社長', '管理者'])
    )
  ) then
    raise exception '休暇申請フォームを送る権限がありません';
  end if;

  update profiles
     set leave_request_enabled = p_enabled,
         leave_enabled_by = case when p_enabled then auth.uid() else null end
   where id = p_user_id;
end $function$;

-- ========================================
-- 2) NULL を返していた判定関数（いまは RLS でしか使われていないので実害は無いが、
--    「if not 判定() then 拒否」の形で使われた瞬間に素通りの元になる）
-- ========================================
create or replace function public.has_feature_permission(p_feature text)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  -- 🚨 全体を coalesce で包み、NULL を返さない
  select coalesce(
    is_admin()
    or exists (
      select 1
      from profiles p
      join roles r
        on r.id = p.role_id
        or (p.role_id is null and r.name = p.role_title)
      join feature_permissions fp
        on fp.role_id = r.id and fp.feature_key = p_feature
      where p.id = auth.uid() and fp.enabled
    ), false);
$function$;

create or replace function public.oap_can_view(p_recipient uuid, p_proposer uuid)
returns boolean
language sql
stable security definer
set search_path to 'public'
as $function$
  -- 🚨 auth.uid() が null のとき「p_recipient = null」は NULL になるので、
  --    is not distinct from を使い、全体も coalesce で包む
  select coalesce(
    p_recipient is not distinct from auth.uid()
    or p_proposer is not distinct from auth.uid()
    or is_admin()
    or (has_feature_permission('overtime_summary')
        and overtime_role_rank_target(p_recipient) >= (select overtime_role_rank(auth.uid()))), false);
$function$;

-- 🚨 room_can_see_contacts も NULL を返すが、**ここでは触っていない**。
--    場所予約（もう一方の担当者の領域）の関数で、しかも一般スタッフでも NULL を返すため、
--    coalesce で false に確定させると「本来は見えるべき人に見えなくなる」可能性がある。
--    担当者に伝えて、その人が直すこと。

-- 🚨 anon（ログインしていない人）の実行権限を外す。
--    anon だけ名指ししても外れない（anon は PUBLIC の一員）。public と両方から外す。
revoke execute on function public.set_leave_request_enabled(uuid, boolean) from public, anon;
grant  execute on function public.set_leave_request_enabled(uuid, boolean) to authenticated;

-- 🚨 has_feature_permission / oap_can_view は **RLSポリシーの中から呼ばれる**。
--    ポリシーは呼び出したユーザーの権限で評価されるため、anon から実行できないと
--    未ログイン時にポリシー評価そのものが失敗する。ここは権限を外さない
--    （どちらも読み取り専用で、中で auth.uid() を見て判定している）。
