-- 管理部シフト表：四条本校の「締め」を、同じ時刻に終わる人が2人以上いるときに選んだ結果（2026-10-14 ユーザー確定・docs/計画-管理部シフト表.md）
-- ・表そのものは入力しない（勤務表 weekly_shift_patterns から画面で作る）。ここに残すのは「締めの選び直し」だけ
-- ・1曜日に1行。選んだときの候補（candidates）も残し、勤務表が変わって候補が変わったら画面はこの行を使わない（未定に戻る）
-- ・見られる人：シフト管理を開ける人（can_manage_admin_tab('shift_patterns')・こども／大人のシフト表と同じ）と管理者
-- ・選べる人：マネージャー以上と管理者だけ（ユーザー確定 B・is_manager_plus()）
-- 🚨 表は画面から直接書かない（admin_shift_set_closer だけ）

begin;

create table if not exists public.admin_shift_closers (
  day_kind   text primary key check (day_kind in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')),
  user_id    uuid not null references auth.users(id) on delete cascade,
  candidates uuid[] not null,
  chosen_by  uuid,
  chosen_at  timestamptz not null default now()
);
alter table public.admin_shift_closers enable row level security;
drop policy if exists admin_shift_closers_select on public.admin_shift_closers;
create policy admin_shift_closers_select on public.admin_shift_closers
  for select to authenticated
  using (is_admin() or (select can_manage_admin_tab('shift_patterns'::text)));

-- 締めを選ぶ（p_user が空なら選んだ結果を消して「未定」に戻す）
create or replace function public.admin_shift_set_closer(p_day text, p_user uuid, p_candidates uuid[])
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not (is_admin() or is_manager_plus()) then
    raise exception '締めを選べるのはマネージャー以上と管理者だけです' using errcode = '42501';
  end if;
  if not (is_admin() or can_manage_admin_tab('shift_patterns')) then
    raise exception 'シフト管理を開ける人だけが選べます' using errcode = '42501';
  end if;
  if p_day not in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun') then
    raise exception '曜日の指定が正しくありません';
  end if;
  if p_user is null then
    delete from public.admin_shift_closers where day_kind = p_day;
    return;
  end if;
  if p_candidates is null or array_length(p_candidates, 1) is null or array_length(p_candidates, 1) < 2 then
    raise exception '同じ時刻に終わる人が2人以上いるときだけ選べます';
  end if;
  if not (p_user = any(p_candidates)) then
    raise exception '選んだ人が候補に入っていません';
  end if;
  insert into public.admin_shift_closers (day_kind, user_id, candidates, chosen_by, chosen_at)
  values (p_day, p_user, p_candidates, auth.uid(), now())
  on conflict (day_kind) do update
    set user_id = excluded.user_id, candidates = excluded.candidates, chosen_by = excluded.chosen_by, chosen_at = excluded.chosen_at;
end;
$function$;

revoke execute on function public.admin_shift_set_closer(text, uuid, uuid[]) from public, anon;
grant execute on function public.admin_shift_set_closer(text, uuid, uuid[]) to authenticated;

commit;
