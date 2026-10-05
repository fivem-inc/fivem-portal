-- シフト調整の［調整済み（アプリ外）］（2026-10-05 ユーザー確定）
--
-- きっかけ：現場から「［調整不要］の並びに［調整済］が欲しい」。電話・口頭など、アプリを使わずに調整を済ませた日を記録したい。
-- 決めたこと（ユーザー確定）：
--   ・ボタンと状態の名前は「調整済み（アプリ外）」
--   ・押したら「誰が出勤するか」を選べる（その日の勤怠カレンダーに予定がある人を上に・名前で探せる・選ばなくても記録できる・複数可）
--   ・Google カレンダーへの書き込み・通知はしない（外で調整したときはカレンダーに人が入れている）
--   ・勤怠カレンダーの印は「シフト 調整済」（アプリで決めたときと同じ）。「シフト未調整だけ」の絞り込みからは外れる
-- 作り：
--   ・場の状態の種類は増やさない：調整済み（アプリ外）＝ status 'decided' ＋ 印 adjusted_outside=true ＋ 出勤する人 outside_user_ids
--     → 休暇の列（shift_adjust_sync_leave_status）は今までどおり 'adjusted' になり、カレンダーの印も「調整済」になる
--     → 案は今までのトリガー（trg_zz_shift_adjust_clear_plans）が消す
--     → 取り消しは今までの shift_adjust_undecide（割り当てが無いので、勤怠・依頼は何も消えない）。状態は「調整中」に戻る
--   ・既存の関数は1つも書き換えない。新しい関数 shift_adjust_mark_outside を足すだけ
-- 🚨 割り当て（shift_adjust_assignments）は作らない。勤怠カレンダーの記録・Google カレンダー・残業申請の依頼には一切触れない
--
-- ロールバック手順:
--   drop function if exists public.shift_adjust_mark_outside(uuid, uuid[]);
--   drop trigger if exists trg_shift_adjust_slot_outside on public.shift_adjust_slots;
--   drop function if exists public.trg_shift_adjust_slot_outside();
--   alter table public.shift_adjust_slots drop column if exists outside_user_ids, drop column if exists adjusted_outside;

-- 1. 印と出勤する人
alter table public.shift_adjust_slots
  add column if not exists adjusted_outside boolean not null default false,
  add column if not exists outside_user_ids uuid[] not null default '{}';
comment on column public.shift_adjust_slots.adjusted_outside is
  '調整済み（アプリ外）の印（2026-10-05）。status=''decided'' のときだけ true になり得る（それ以外の状態ではトリガーが false に戻す）';
comment on column public.shift_adjust_slots.outside_user_ids is
  '調整済み（アプリ外）で記録した「出勤する人」（2026-10-05・空でもよい）。記録だけで、勤怠・Google カレンダーには使わない';

-- 2. 「調整済み」以外になったら印と人を外す（印だけが残らないように。どの関数から状態を変えても効く）
create or replace function public.trg_shift_adjust_slot_outside()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status is distinct from 'decided' then
    new.adjusted_outside := false;
    new.outside_user_ids := '{}';
  end if;
  return new;
end;
$$;
revoke execute on function public.trg_shift_adjust_slot_outside() from public, anon, authenticated;
drop trigger if exists trg_shift_adjust_slot_outside on public.shift_adjust_slots;
create trigger trg_shift_adjust_slot_outside
  before insert or update on public.shift_adjust_slots
  for each row execute function public.trg_shift_adjust_slot_outside();

-- 3. ［調整済み（アプリ外）］を押したとき。歯止めは shift_adjust_set_status と同じ
create or replace function public.shift_adjust_mark_outside(p_slot_id uuid, p_user_ids uuid[])
returns table(ok boolean, reason text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean;
  v_slot     shift_adjust_slots%rowtype;
  v_ids      uuid[];
begin
  v_is_admin := coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
  if not (v_is_admin or public.has_feature_permission('shift_adjust_decide')) then
    return query select false, 'シフト調整を決める権限がありません（管理画面の「役職・機能権限」で設定します）'::text;
    return;
  end if;

  select * into v_slot from shift_adjust_slots s where s.id = p_slot_id for update;
  if not found then
    return query select false, 'この調整の場は見つかりません'::text;
    return;
  end if;
  if v_slot.target_user_id = auth.uid() then
    return query select false, '自分の休みの調整は、この画面からは変えられません'::text;
    return;
  end if;
  if exists (select 1 from shift_adjust_assignments a where a.slot_id = p_slot_id) then
    return query select false, 'すでに出勤する人が決まっています。先に「決定を取り消す」から片付けてください'::text;
    return;
  end if;
  if v_slot.status in ('closed_past', 'cause_cancelled') then
    return query select false, 'この場はもう閉じています（過ぎた日、または休みが取り消されました）'::text;
    return;
  end if;
  -- 🚨 出勤のお願いを送った場は変えさせない（パートの返事の画面が「現在調整中です」のまま残るため・set_status と同じ）
  if exists (select 1 from shift_adjust_part_requests r where r.slot_id = p_slot_id) then
    return query select false, '出勤のお願いを送ったため、選び直せません。決定するか、お願いの返事を待ってください'::text;
    return;
  end if;

  -- 出勤する人：実在する人だけ・重ねない・休む本人は入れない
  select coalesce(array_agg(distinct p.id), '{}') into v_ids
    from profiles p
   where p.id = any(coalesce(p_user_ids, '{}'))
     and p.id is distinct from v_slot.target_user_id;

  update shift_adjust_slots s
     set status           = 'decided',
         adjusted_outside = true,
         outside_user_ids = v_ids,
         decided_by       = auth.uid(),
         decided_at       = now(),
         updated_at       = now()
   where s.id = p_slot_id;

  return query select true, ''::text;
end;
$$;
-- 🚨 Supabase は新しい関数に anon の実行権限を自動で付ける。from public だけでは外れないので anon も明示する
revoke execute on function public.shift_adjust_mark_outside(uuid, uuid[]) from public;
revoke execute on function public.shift_adjust_mark_outside(uuid, uuid[]) from anon;
grant execute on function public.shift_adjust_mark_outside(uuid, uuid[]) to authenticated;

-- 確認用:
--   select has_function_privilege('anon', 'public.shift_adjust_mark_outside(uuid, uuid[])', 'execute');          -- false
--   select has_function_privilege('authenticated', 'public.shift_adjust_mark_outside(uuid, uuid[])', 'execute'); -- true
