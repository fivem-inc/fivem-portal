-- ============================================================
-- 2026-10-21  休職（段6：シフトの表・シフト調整から外す）
-- 計画：docs/計画-休職-段5-段6.md（一問一答 ②・③）
-- ============================================================
-- ・leave_ids_on(日)：その日に休職中の人の id（シフト調整の代わりの候補・全員のシフト予定から黙って外すため）
--     呼べるのは、シフト調整を見る権限（shift_adjust_view）・全員のシフト予定（shift_pattern_directory）がある人、マネージャー以上と管理者だけ（ほかは空）
--     日付は今日の7日前〜60日先だけ（好きな日で呼んで、だれがいつ休職かを調べられないように・レビュー指摘）
--     🚨 シフト管理の表（勤務表・こども／大人・管理部・掃除・勉強会）はマネージャー以上と管理者だけが開くので、staff_leaves を RLS のまま読む（この関数は使わない）
-- ・シフト調整：休職中の日に、出勤のお願い（shift_adjust_part_requests）を送る・代わりに入る人に決める（shift_adjust_assignments）のを DB でも止める
--     （画面で外すだけでなく、古い画面・同時の操作でも入らないように。shift_adjust_* の関数は変えずに、表のトリガーで止める）
-- 🚨 いま休職中の人は 0 人。適用しても誰の動きも変わらない
--
-- ロールバック手順:
--   drop trigger if exists trg_leave_block_part_request on shift_adjust_part_requests;
--   drop trigger if exists trg_leave_block_assignment on shift_adjust_assignments;
--   drop function if exists leave_block_shift_adjust(), leave_ids_on(date);

begin;

create or replace function public.leave_ids_on(p_day date)
returns setof uuid
language plpgsql stable security definer set search_path to 'public'
as $function$
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
begin
  if p_day is null or p_day < v_today - 7 or p_day > v_today + 60 then return; end if;
  if not (is_admin() or is_manager_plus()
          or has_feature_permission('shift_adjust_view') or has_feature_permission('shift_pattern_directory')) then
    return;
  end if;
  return query
    select l.user_id from staff_leaves l
     where l.cancelled_at is null and staff_leave_active_on(l.user_id, p_day);
end;
$function$;
revoke execute on function public.leave_ids_on(date) from public, anon;
grant execute on function public.leave_ids_on(date) to authenticated;

-- 休職中の日に、出勤のお願い・代わりに入る人に決めるのを止める（文に「休職」は出さない＝画面でも黙って外している）
create or replace function public.leave_block_shift_adjust()
returns trigger
language plpgsql security definer set search_path to 'public'
as $function$
declare
  v_day  date;
  v_name text;
begin
  if tg_table_name = 'shift_adjust_part_requests' then
    v_day := new.target_date;
  else
    select s.target_date into v_day from shift_adjust_slots s where s.id = new.slot_id;
  end if;
  if v_day is not null and staff_leave_active_on(new.user_id, v_day) then
    select name into v_name from profiles where id = new.user_id;
    raise exception '%さんは、この日は選べません。別の方を選んでください', coalesce(regexp_replace(v_name, '[[:space:]　]+', ' ', 'g'), 'この方')
      using errcode = 'P0001';
  end if;
  return new;
end;
$function$;
revoke execute on function public.leave_block_shift_adjust() from public, anon, authenticated;

drop trigger if exists trg_leave_block_part_request on public.shift_adjust_part_requests;
create trigger trg_leave_block_part_request before insert on public.shift_adjust_part_requests
  for each row execute function public.leave_block_shift_adjust();
drop trigger if exists trg_leave_block_assignment on public.shift_adjust_assignments;
create trigger trg_leave_block_assignment before insert on public.shift_adjust_assignments
  for each row execute function public.leave_block_shift_adjust();

commit;
