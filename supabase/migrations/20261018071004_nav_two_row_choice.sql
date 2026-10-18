-- スマホのナビの2段を本人が選ぶ（2026-10-17 ユーザー確定・計画 docs/計画-ナビの並び替え.md）
-- ・profiles.nav_two_row：本人の選択（true＝2段／false＝1段／null＝選んでいない＝管理画面の「2段を使う人」に従う）
-- ・本人は profiles を直接更新できないので RPC set_my_nav_two_row（set_my_nav_order と同じ形）
-- ・選べる欄を誰に出すかは app_settings 'nav_rollout' の two_row_choice（無い＝オフとして読む・ここでは値を入れない＝出しても誰の画面も変わらない）
-- 🚨 選べる人でなくなったら、選んだ値は消さずに使わない（オンに戻すと元に戻る）

begin;

alter table public.profiles add column if not exists nav_two_row boolean;
comment on column public.profiles.nav_two_row is 'スマホのナビの2段の本人の選択（true＝2段・false＝1段・null＝管理者の設定に従う・2026-10-17）。書くのは set_my_nav_two_row だけ';

create or replace function public.set_my_nav_two_row(p_value boolean)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if auth.uid() is null then
    raise exception 'NAV_TWO_ROW_AUTH: ログインしてください' using errcode = '42501';
  end if;
  -- null＝選ぶのをやめて管理者の設定に戻す
  update profiles set nav_two_row = p_value where id = auth.uid();
  if not found then
    raise exception 'NAV_TWO_ROW_NO_PROFILE: プロフィールが見つかりません' using errcode = 'P0002';
  end if;
end;
$function$;
revoke execute on function public.set_my_nav_two_row(boolean) from public;
revoke execute on function public.set_my_nav_two_row(boolean) from anon;
grant execute on function public.set_my_nav_two_row(boolean) to authenticated;

commit;
