-- ナビの並び替え（2026-10-17・計画 docs/計画-ナビの並び替え.md の 2b）
-- ・profiles.nav_order：本人の並び（ナビのボタンのキーの配列・空＝管理者の並び）。本人は profiles を直接更新できないので RPC set_my_nav_order
-- ・app_settings 'nav_order'：管理者が決める全員の初めの並び（{"keys": [...]}・空＝今の並び）
-- ・app_settings 'nav_rollout'：試してから広げる切り替え（reorder＝本人の並べ替え／two_row＝スマホの2段）。
--   mode は off（今のナビのまま）／selected（選んだ人・役職だけ）／all（全員）。どちらも off で入れる＝出しても誰の見た目も変わらない
-- 🚨 キーの一覧（どんなボタンがあるか）は DB に書き写さない（画面の lib/navItems.ts だけ）。ここでは形・数・重なりだけ確かめる

begin;

alter table public.profiles add column if not exists nav_order text[];
comment on column public.profiles.nav_order is '上のナビの本人の並び（ボタンのキーの配列・空＝管理者の並び・2026-10-17）。書くのは set_my_nav_order だけ';

create or replace function public.set_my_nav_order(p_keys text[])
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_n integer := coalesce(array_length(p_keys, 1), 0);
begin
  if auth.uid() is null then
    raise exception 'NAV_ORDER_AUTH: ログインしてください' using errcode = '42501';
  end if;
  if v_n > 30 then
    raise exception 'NAV_ORDER_TOO_MANY: 並びが長すぎます' using errcode = '22023';
  end if;
  if v_n > 0 then
    if exists (select 1 from unnest(p_keys) k where k is null or k !~ '^[a-z_]{1,32}$') then
      raise exception 'NAV_ORDER_BAD_KEY: 並びの中身が正しくありません' using errcode = '22023';
    end if;
    if (select count(distinct k) from unnest(p_keys) k) <> v_n then
      raise exception 'NAV_ORDER_DUP: 同じボタンが2回入っています' using errcode = '22023';
    end if;
  end if;
  -- 空＝管理者の並びに戻す
  update profiles set nav_order = case when v_n = 0 then null else p_keys end where id = auth.uid();
end;
$function$;
revoke execute on function public.set_my_nav_order(text[]) from public;
revoke execute on function public.set_my_nav_order(text[]) from anon;
grant execute on function public.set_my_nav_order(text[]) to authenticated;

insert into public.app_settings (key, value) values
  ('nav_order', '{"keys": []}'::jsonb),
  ('nav_rollout', '{"reorder": {"mode": "off", "user_ids": [], "role_ids": []}, "two_row": {"mode": "off", "user_ids": [], "role_ids": []}}'::jsonb)
on conflict (key) do nothing;

commit;
