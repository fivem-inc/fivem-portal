-- シフト調整：途中まで決めた内容を「案」として保存し、誰でも続きから直して決定できるようにする（2026-09-14 ユーザー確定）
--
-- 【決めたこと】
--   ・呼び名は「案を保存」。1つの場に保存できる案は1つだけ・決める権限がある人なら誰でも上書きできる
--   ・保存した人と日時を出す。別の人が先に保存していたら、上書きする前に知らせる（p_expected_saved_at）
--   ・保存したら相談の欄に「案を保存しました：…」を自動で残す（上書きしても前の案が追える）
--   ・「現行シフトで対応」「後で決める」に切り替えても案は残す。消えるのは 決定したとき・休みが取り消されたとき・日が過ぎたとき
--
-- 【作るもの】
--   ① shift_adjust_saved_plans（場ごとに1行）
--   ② shift_adjust_save_plan(...)：案を保存する関数（書き込みはこの関数だけ。表に直接書く許可は作らない）
--   ③ 場が 決定・休みの取消・日の経過 になったら案を消すトリガー
--      🚨 決定の関数（shift_adjust_decide）は触らない。状態が変わったことを見て消す
--
-- 🚨 既存の関数は1つも書き換えていない
-- 🚨 戻り値の名前（current_saved_at / current_saved_by）は表の列名と重ならないようにした
--    （2026-09-04 に returns table の名前と列名が重なって 42702 で繰り上げが1件も通らなかった）
-- 🚨 貯め続けない：案は場の状態が終わると消えるので、掃除の cron は要らない

create table if not exists public.shift_adjust_saved_plans (
  slot_id        uuid primary key references public.shift_adjust_slots(id) on delete cascade,
  -- [{ "user_id": "...", "segs": [{ "start": "10:00", "end": "13:00", "location": "四条本校" }] }]
  -- 🚨 途中の案なので、時間が空でも保存できる（決定のときに初めて確かめる）
  assignments    jsonb       not null default '[]'::jsonb,
  do_attendance  boolean     not null default false,
  do_request     boolean     not null default false,
  memo           text,
  saved_by       uuid        not null,
  saved_at       timestamptz not null default now()
);

comment on table public.shift_adjust_saved_plans is
  'シフト調整の保存中の案（場ごとに1つ・誰でも上書き）。決定・休みの取消・日の経過で消える（2026-09-14）';

alter table public.shift_adjust_saved_plans enable row level security;

-- 読むのは「シフト調整を見る」権限がある人。🚨 休んだ本人には見せない（ほかの表と同じ決まり）
drop policy if exists shift_adjust_saved_plans_select on public.shift_adjust_saved_plans;
create policy shift_adjust_saved_plans_select on public.shift_adjust_saved_plans
  for select to authenticated
  using (exists (
    select 1 from public.shift_adjust_slots s
     where s.id = shift_adjust_saved_plans.slot_id
       and (select public.has_feature_permission('shift_adjust_view'))
       and s.target_user_id <> auth.uid()
  ));

revoke all on public.shift_adjust_saved_plans from anon;
grant select on public.shift_adjust_saved_plans to authenticated;

-- ② 案を保存する
create or replace function public.shift_adjust_save_plan(
  p_slot_id uuid,
  p_assignments jsonb,
  p_do_attendance boolean,
  p_do_request boolean,
  p_memo text,
  p_summary text,
  p_expected_saved_at timestamptz,
  p_overwrite boolean default false
)
returns table(ok boolean, reason text, current_saved_at timestamptz, current_saved_by uuid)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_is_admin boolean;
  v_slot     shift_adjust_slots%rowtype;
  v_cur      shift_adjust_saved_plans%rowtype;
  v_now      timestamptz := now();
begin
  v_is_admin := coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
  if not (v_is_admin or public.has_feature_permission('shift_adjust_decide')) then
    return query select false, 'シフト調整を決める権限がありません（管理画面の「役職・機能権限」で設定します）'::text, null::timestamptz, null::uuid;
    return;
  end if;

  if p_assignments is null or jsonb_typeof(p_assignments) <> 'array' then
    return query select false, '案の形が正しくありません'::text, null::timestamptz, null::uuid;
    return;
  end if;

  select * into v_slot from shift_adjust_slots s where s.id = p_slot_id for update;
  if not found then
    return query select false, 'この調整の場は見つかりません'::text, null::timestamptz, null::uuid;
    return;
  end if;
  if v_slot.target_user_id = auth.uid() then
    return query select false, '自分の休みの調整は、この画面からは変えられません'::text, null::timestamptz, null::uuid;
    return;
  end if;
  if v_slot.status not in ('pending', 'working') then
    return query select false, 'この場はもう決まっているか、閉じています。案は保存できません'::text, null::timestamptz, null::uuid;
    return;
  end if;

  -- 🚨 別の人が、この画面を開いたあとに保存していたら上書きしない（上書きするかは画面で聞く）
  select * into v_cur from shift_adjust_saved_plans sp where sp.slot_id = p_slot_id;
  if found and not coalesce(p_overwrite, false)
     and v_cur.saved_at is distinct from p_expected_saved_at then
    return query select false, 'conflict'::text, v_cur.saved_at, v_cur.saved_by;
    return;
  end if;

  insert into shift_adjust_saved_plans as sp
    (slot_id, assignments, do_attendance, do_request, memo, saved_by, saved_at)
  values
    (p_slot_id, p_assignments, coalesce(p_do_attendance, false), coalesce(p_do_request, false),
     nullif(p_memo, ''), auth.uid(), v_now)
  on conflict (slot_id) do update
     set assignments   = excluded.assignments,
         do_attendance = excluded.do_attendance,
         do_request    = excluded.do_request,
         memo          = excluded.memo,
         saved_by      = excluded.saved_by,
         saved_at      = excluded.saved_at;

  -- 相談の欄に記録を残す（上書きしても、前に誰がどんな案にしていたかが追える）
  insert into shift_adjust_comments (slot_id, user_id, body)
  values (p_slot_id, auth.uid(),
          '案を保存しました' || case when coalesce(p_summary, '') <> '' then '：' || p_summary else '' end);

  return query select true, ''::text, v_now, auth.uid();
end $function$;

revoke execute on function public.shift_adjust_save_plan(uuid, jsonb, boolean, boolean, text, text, timestamptz, boolean) from public;
revoke execute on function public.shift_adjust_save_plan(uuid, jsonb, boolean, boolean, text, text, timestamptz, boolean) from anon;
grant execute on function public.shift_adjust_save_plan(uuid, jsonb, boolean, boolean, text, text, timestamptz, boolean) to authenticated;

-- ③ 場が終わったら案を消す
create or replace function public.trg_shift_adjust_clear_saved_plan()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- 🚨 失敗しても状態の変更（決定など）は止めない
  begin
    delete from shift_adjust_saved_plans where slot_id = new.id;
  exception when others then
    raise warning '[trg_shift_adjust_clear_saved_plan] 案を消せませんでした: %', sqlerrm;
  end;
  return null;
end $function$;

revoke execute on function public.trg_shift_adjust_clear_saved_plan() from public;
revoke execute on function public.trg_shift_adjust_clear_saved_plan() from anon;

drop trigger if exists trg_zz_shift_adjust_clear_saved_plan on public.shift_adjust_slots;
create trigger trg_zz_shift_adjust_clear_saved_plan
  after update on public.shift_adjust_slots
  for each row
  when (old.status is distinct from new.status and new.status in ('decided', 'cause_cancelled', 'closed_past'))
  execute function public.trg_shift_adjust_clear_saved_plan();
