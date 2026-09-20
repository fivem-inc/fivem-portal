-- 退職者の申請期間・2段目の手順5（2026-09-20・設計書 §8-5）
-- ログインの鍵（JWT）を作るときに、期限内の退職者だけ role を retiree にする。
-- 🚨 この関数を作っただけでは何も起きない。Supabase の管理画面
--    （Authentication → Hooks → Customize Access Token (JWT) Claims）で
--    public.custom_access_token_hook を選んで有効にして初めて動く（ユーザーが実施）。
-- 🚨 ここで例外を投げるとログインが全員止まる。中で必ず受け止めて、失敗したら今までどおり（authenticated）に倒す。

create or replace function public.custom_access_token_hook(event jsonb)
 returns jsonb
 language plpgsql
 stable
 security definer
 set search_path to 'public'
as $fn$
declare
  v_claims jsonb;
  v_is_retiree boolean;
begin
  -- 期限内の退職者か（退職済み・退職の記録あり・期限が今日以降）。それ以外は何もしない
  select true into v_is_retiree
    from public.profiles p
   where p.id = (event ->> 'user_id')::uuid
     and p.is_active = false
     and p.retired_at is not null
     and p.retiree_access_until is not null
     and p.retiree_access_until >= (now() at time zone 'Asia/Tokyo')::date;

  if not coalesce(v_is_retiree, false) then
    return event;
  end if;

  v_claims := coalesce(event -> 'claims', '{}'::jsonb);
  v_claims := jsonb_set(v_claims, '{role}', '"retiree"'::jsonb, true);
  return jsonb_set(event, '{claims}', v_claims, true);
exception when others then
  -- 🚨 何が起きてもログインは止めない
  return event;
end;
$fn$;

comment on function public.custom_access_token_hook(jsonb) is
  '期限内の退職者だけ JWT の role を retiree にする（2026-09-20・手順5）。失敗したら何もせず返す＝ログインは止めない';

-- 呼べるのは Supabase の認証だけ
revoke execute on function public.custom_access_token_hook(jsonb) from public;
revoke execute on function public.custom_access_token_hook(jsonb) from anon;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated;
revoke execute on function public.custom_access_token_hook(jsonb) from service_role;
grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;

-- 戻し版（この migration を取り消すとき）:
--   ① 先に Supabase の管理画面で Hook を「無効」にする（関数を消す前に必ず）
--   ② drop function public.custom_access_token_hook(jsonb);
