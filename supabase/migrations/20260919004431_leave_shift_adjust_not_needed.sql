-- 休暇のシフト調整に「調整不要」を足す（2026-09-19 ユーザー確定・案A）
--
-- きっかけ：10/31（休館日・社員出勤日（有休奨励日））の有給9件が、ふつうの休暇と同じく「シフト 未」で登録され、
--   9/19 朝に「シフト調整が未です」の通知まで出た。奨励日は休館日なので調整は要らない。
-- ・休暇の日が**すべて奨励日**（company_calendar.kind='work_on_closed_encouraged'）なら、最初から 'not_needed'（自動）
--   🚨 奨励日の回答で入った行（reason='【有給奨励日】'）だけでなく、ふつうの申請で出した行も**日付で**判定する
-- ・カレンダーのボタンに［調整不要］を足す（ほかの休暇にも使える）→ set_leave_shift_adjust が 'not_needed' を受け付ける
-- ・作業場（shift_adjust_slots）の状態の種類は増やさない：調整不要は場では「変更なし（no_change）」
--   🚨 逆向きの同期（shift_adjust_sync_leave_status）で「確認済（変更なし）」に戻らないようにする
-- ・朝の通知（remind-leave-shift-adjust）は 'pending' だけを見るので、変えずに外れる
--
-- 🚨 3つの関数は**本番の実定義（pg_get_functiondef・2026-09-19 取得）から起こした**。差分は「2026-09-19」の注記の行だけ

-- 1. 状態の決まり
alter table public.leave_requests drop constraint if exists leave_requests_shift_adjust_status_check;
alter table public.leave_requests add constraint leave_requests_shift_adjust_status_check
  check (shift_adjust_status = any (array['pending', 'adjusted', 'no_change', 'not_needed']));

-- 2. 休暇の日がすべて奨励日か（判定はこの1か所）
create or replace function public.leave_all_encouraged(p_leave_dates text, p_start date, p_end date)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(array_length(d.days, 1), 0) > 0
     and not exists (
           select 1 from unnest(d.days) x(day)
            where not exists (select 1 from company_calendar c
                               where c.date = x.day and c.kind = 'work_on_closed_encouraged'))
    from (select public.shift_adjust_days(p_leave_dates, p_start, p_end) as days) d;
$$;
revoke execute on function public.leave_all_encouraged(text, date, date) from public, anon, authenticated;

-- 3. 登録・日付の変更のとき、まだ「未」なら「調整不要」にする（BEFORE なので作業場の AFTER トリガーより先に効く）
create or replace function public.trg_leave_shift_adjust_not_needed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(new.shift_adjust_status, 'pending') = 'pending'
     and public.leave_all_encouraged(new.leave_dates, new.start_date, new.end_date) then
    new.shift_adjust_status := 'not_needed';
  end if;
  return new;
end;
$$;
revoke execute on function public.trg_leave_shift_adjust_not_needed() from public, anon, authenticated;
drop trigger if exists trg_leave_shift_adjust_not_needed on public.leave_requests;
create trigger trg_leave_shift_adjust_not_needed
  before insert or update of leave_dates, start_date, end_date on public.leave_requests
  for each row execute function public.trg_leave_shift_adjust_not_needed();

-- 4. 本番の実定義から起こした3つ
CREATE OR REPLACE FUNCTION public.set_leave_shift_adjust(p_id uuid, p_status text)
 RETURNS TABLE(ok boolean, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role_id uuid;
  v_is_admin boolean;
  v_count int;
begin
  if p_status not in ('pending', 'adjusted', 'no_change', 'not_needed') then
    return query select false, '状態の値が正しくありません'::text;
    return;
  end if;

  v_is_admin := coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
  select role_id into v_role_id from profiles where id = auth.uid();

  if not (v_is_admin or exists (
        select 1
          from feature_permissions fp
         where fp.feature_key = 'leave_shift_adjust'
           and fp.enabled
           and fp.role_id = v_role_id)) then
    return query select false, 'シフト調整の状態を変える権限がありません（管理画面の「役職・機能権限」で設定します）'::text;
    return;
  end if;

  update leave_requests
     set shift_adjust_status = p_status,
         shift_adjusted_at   = case when p_status = 'pending' then null else now() end,
         shift_adjusted_by   = case when p_status = 'pending' then null else auth.uid() end
   where id = p_id
     and status in ('manager_approved', 'admin_approved', 'approved');

  get diagnostics v_count = row_count;
  if v_count = 0 then
    return query select false, 'この休暇は受理前か、すでに取り消されています'::text;
    return;
  end if;

  -- ───── ここから下が今回足した「同期」─────
  -- 🚨 **失敗しても今までの動きを巻き戻さない。** ここで例外を投げると、
  --    せっかく成功した上の update ごと取り消され、ボタンが効かなくなる。
  --    新しい作業場はまだテスト中なので、こちらの都合で本番の運用を止めてはいけない。
  begin
    update shift_adjust_slots s
       set status      = case p_status
                           when 'pending'   then 'pending'
                           when 'adjusted'  then 'decided'
                           -- 'no_change' と 'not_needed'（調整不要・2026-09-19）はどちらも場では「変更なし」
                           else                  'no_change'
                         end,
           decided_by  = case when p_status = 'pending' then null else auth.uid() end,
           decided_at  = case when p_status = 'pending' then null else now() end,
           updated_at  = now()
     where s.cause_leave_request_id = p_id
       -- 🚨 すでに「誰が入るか」まで決まっている場は触らない（勤怠の記録が宙に浮くため）
       and not exists (
             select 1 from shift_adjust_assignments a where a.slot_id = s.id
           );
  exception when others then
    raise warning '[set_leave_shift_adjust] 新しい作業場の同期に失敗しました: %', sqlerrm;
  end;

  return query select true, ''::text;
end $function$;

CREATE OR REPLACE FUNCTION public.shift_adjust_sync_leave_status(p_leave_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_new text;
  v_by  uuid;
  v_at  timestamptz;
begin
  if p_leave_id is null then
    return;
  end if;

  select case
           when count(*) filter (where s.status in ('pending', 'working')) > 0 then 'pending'
           when count(*) filter (where s.status = 'decided')                > 0 then 'adjusted'
           when count(*) filter (where s.status = 'no_change')              > 0 then 'no_change'
           else null
         end
    into v_new
    from shift_adjust_slots s
   where s.cause_leave_request_id = p_leave_id
     and s.status in ('pending', 'working', 'decided', 'no_change');

  -- 数に入る場が1つも無ければ、古い列には触らない（今までの値を守る）
  if v_new is null then
    return;
  end if;

  select s.decided_by, s.decided_at
    into v_by, v_at
    from shift_adjust_slots s
   where s.cause_leave_request_id = p_leave_id
     and s.decided_at is not null
   order by s.decided_at desc
   limit 1;

  -- 🚨 値が変わるときだけ書く。同じ値の書き込みを繰り返すと、
  --    古いボタン（set_leave_shift_adjust）との間で行ったり来たりする芽になる
  update leave_requests lr
     set shift_adjust_status = v_new,
         shift_adjusted_at   = case when v_new = 'pending' then null else coalesce(v_at, now()) end,
         shift_adjusted_by   = case when v_new = 'pending' then null else v_by end
   where lr.id = p_leave_id
     and lr.shift_adjust_status is distinct from v_new
     -- 🚨 調整不要（2026-09-19）は、場が「変更なし」のあいだは「確認済（変更なし）」で上書きしない
     and not (lr.shift_adjust_status = 'not_needed' and v_new = 'no_change');
end $function$;

CREATE OR REPLACE FUNCTION public.shift_adjust_recompute(p_user_id uuid, p_date date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_leave_id     uuid;
  v_leave_old    text;
  v_absent_id    uuid;
  v_slot_id      uuid;
  v_slot_status  text;
  v_has_assign   boolean;
  v_cause        text;
  v_seed         text;
  v_today        date := (now() at time zone 'Asia/Tokyo')::date;
begin
  if p_user_id is null or p_date is null then
    return;
  end if;

  -- (1) その日を含む「受理済みの休暇」。🚨 奨励日の回答が作った行は除く（上の訂正を参照）
  select lr.id, lr.shift_adjust_status
    into v_leave_id, v_leave_old
    from leave_requests lr
   where lr.user_id = p_user_id
     and lr.status in ('manager_approved', 'admin_approved', 'approved')
     and coalesce(lr.reason, '') <> '【有給奨励日】'
     and p_date = any (public.shift_adjust_days(lr.leave_dates, lr.start_date, lr.end_date))
   order by lr.created_at nulls last, lr.id
   limit 1;

  -- (2) その日の欠勤
  select ae.id
    into v_absent_id
    from attendance_exceptions ae
   where ae.user_id = p_user_id
     and ae.date = p_date
     and ae.type = 'absent'
   order by ae.created_at nulls last, ae.id
   limit 1;

  select s.id, s.status
    into v_slot_id, v_slot_status
    from shift_adjust_slots s
   where s.target_user_id = p_user_id
     and s.target_date = p_date;

  -- (3) 休みがもう無い＝きっかけが消えた
  if v_leave_id is null and v_absent_id is null then
    -- 🚨 場は消さない。**決めた割り当てが残っているかもしれない**ので、
    --    「休みが取り消されました」と分かる状態にして、人に片付けてもらう
    if v_slot_id is not null and v_slot_status <> 'cause_cancelled' then
      update shift_adjust_slots
         set status = 'cause_cancelled',
             updated_at = now()
       where id = v_slot_id;
    end if;
    return;
  end if;

  -- 🚨 同じ日に休暇と欠勤が重なることがある（本番に2件）。場は1つで、きっかけは休暇を優先する
  v_cause := case when v_leave_id is not null then 'leave' else 'absent' end;

  -- (4) まだ場が無い＝新しく作る
  if v_slot_id is null then
    -- 🚨🚨 生まれたときの状態は、**古い列から引き継ぐ**。
    --    いつも pending で作ると、すでに「調整済み」にしてある休暇（本番に7件）を
    --    触っただけで場が pending で生まれ、逆向きの同期で古い列が未調整に戻り、
    --    カレンダーの印が巻き戻る。手順3の対応（adjusted→decided）と同じ向きで揃える
    v_seed := case v_leave_old
                when 'adjusted'  then 'decided'
                when 'no_change' then 'no_change'
                when 'not_needed' then 'no_change'   -- 調整不要（2026-09-19）
                else                  'pending'
              end;

    -- 過ぎた日は知らせない（設計書 1.）。🚨 閉じた状態で作るので逆向きの同期もしない
    --    ＝古い列は今までどおり「未調整」のまま。カレンダーの印は変わらない
    if v_seed = 'pending' and p_date < v_today then
      v_seed := 'closed_past';
    end if;

    insert into shift_adjust_slots
      (target_user_id, target_date, cause,
       cause_leave_request_id, cause_attendance_exception_id, status)
    values
      (p_user_id, p_date, v_cause, v_leave_id, v_absent_id, v_seed)
    on conflict (target_user_id, target_date) do nothing;
    return;
  end if;

  -- (5) すでにある場：きっかけを今の事実に合わせる
  select exists (select 1 from shift_adjust_assignments a where a.slot_id = v_slot_id)
    into v_has_assign;

  update shift_adjust_slots s
     set cause                          = v_cause,
         cause_leave_request_id         = v_leave_id,
         cause_attendance_exception_id  = v_absent_id,
         -- 🚨 状態は原則そのまま。**いちど消えた休みが戻ったときだけ**呼び戻す。
         --    割り当てが残っていれば decided に、無ければ pending に
         status = case when s.status = 'cause_cancelled'
                       then (case when v_has_assign then 'decided' else 'pending' end)
                       else s.status
                  end,
         updated_at = now()
   where s.id = v_slot_id;
end $function$;

-- 🚨 create or replace は権限を保つが、念のため anon を明示的に外す（set は今までどおり authenticated に許可）
revoke execute on function public.set_leave_shift_adjust(uuid, text) from anon;
revoke execute on function public.shift_adjust_sync_leave_status(uuid) from anon;
revoke execute on function public.shift_adjust_recompute(uuid, date) from anon;

-- 5. 今ある分：まだ「未」で、日がすべて奨励日の休暇を「調整不要」に
update public.leave_requests
   set shift_adjust_status = 'not_needed'
 where shift_adjust_status = 'pending'
   and public.leave_all_encouraged(leave_dates, start_date, end_date);
