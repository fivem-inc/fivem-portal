-- シフト表の作業中の案に「メモ」（何のための案か）を付ける（2026-10-22 ユーザー確定）
-- ・画面：案のボタンを番号の順・短く（「案1」）にし、選んだ案の名前とメモを黄色い帯に出す。［メモを直す］で書く
-- ・保存は kids_shift_plan_set_memo だけ（kids_shift_plans はもともと画面から直接書けない＝読む決まりだけ）
-- 🚨 メモを直しても案の revision は上げない（マスや前提を直している人に「別の人が保存しました」を出さないため）
-- 🚨 kids_shift_plan_save には触らない（大きな関数を作り直さない）

alter table public.kids_shift_plans
  add column if not exists memo text check (memo is null or length(memo) <= 500);
comment on column public.kids_shift_plans.memo is '案のメモ（何のための案か・500字まで）。kids_shift_plan_set_memo で書く';

create or replace function public.kids_shift_plan_set_memo(p_plan_id uuid, p_memo text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_memo text := nullif(btrim(coalesce(p_memo, '')), '');
  v_n integer;
begin
  if not public.can_manage_admin_tab('shift_patterns') then
    raise exception 'シフト表の案を直す権限がありません' using errcode = '42501';
  end if;
  if v_memo is not null and length(v_memo) > 500 then
    raise exception 'メモは500字までにしてください' using errcode = '22023';
  end if;
  update public.kids_shift_plans
     set memo = v_memo
   where id = p_plan_id and status = 'open';
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return jsonb_build_object('ok', false, 'reason', 'archived');
  end if;
  return jsonb_build_object('ok', true);
end
$$;

revoke all on function public.kids_shift_plan_set_memo(uuid, text) from public;
revoke execute on function public.kids_shift_plan_set_memo(uuid, text) from anon;
grant execute on function public.kids_shift_plan_set_memo(uuid, text) to authenticated;
grant execute on function public.kids_shift_plan_set_memo(uuid, text) to service_role;
