-- ============================================================
-- 2026-09-18  リマインドの送り先「グループ」に、名前のない候補が17件出ていた（実機指摘 C-6）
-- ============================================================
-- 症状：管理画面 → リマインド設定 → 新しいリマインド → 送り先「グループ」を開くと、
--       ふつうの9グループのあとに**文字が空欄の候補が17件**並ぶ。押しても送り先が判別できない。
--
-- 原因（本番DBで実測）：この関数が board_channels を**種類で絞らずに全部**返していた。
--       type 別の実測：group 9件（名前あり）／**dm 14件＋sent_mail 3件＝名前なし17件**。
--       DM と「送信トレイ（メール）」の入れ物は名前を持たないので、空欄の候補として出ていた。
--
-- 直し方：グループだけを返す（1行足すだけ）。
-- 🚨 本番の実定義（pg_get_functiondef）から起こしている。リポジトリのファイルは
--    最後に適用された版とは限らないため（古い版で上書きする事故を避ける）。
-- 🚨 いまのリマインドで DM・sent_mail を指しているものは **0件**（実測）なので、
--    絞り込んでも既存の設定は壊れない。
--
-- ロールバック手順：where 句を消して create or replace し直す（元の定義は上のコメントのとおり）

create or replace function public.reminder_channel_options()
 returns table(id uuid, name text)
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
begin
  if not public.can_manage_admin_tab('scheduled_reminders') then
    raise exception '権限がありません' using errcode = '42501';
  end if;
  return query
    select c.id, c.name
      from public.board_channels c
     where c.type = 'group'   -- 🚨 DM（名前なし）と送信トレイの入れ物を出さない（2026-09-18）
     order by c.name;
end;
$function$;

comment on function public.reminder_channel_options() is
  'リマインド設定の送り先に選べる連絡板のグループ（id と名前だけ）。can_manage_admin_tab(''scheduled_reminders''）。2026-09-18：DM・送信トレイを除外';

-- 🚨 Supabase は新しい関数に anon の実行権限を自動で付ける。create or replace でも念のため外す
revoke execute on function public.reminder_channel_options() from public;
revoke execute on function public.reminder_channel_options() from anon;
grant execute on function public.reminder_channel_options() to authenticated;
