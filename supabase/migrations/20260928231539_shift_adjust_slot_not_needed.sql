-- シフト調整の「調整不要」を1日ずつ持つ（2026-09-28 ユーザー確定）
--
-- きっかけ：10/11（休館日の出勤日）の有給で、マネージャーが［シフト調整］タブから「調整不要」を選べず
--   「確認済（変更なし）」にした。調整不要は休暇1件まるごと（leave_requests.shift_adjust_status）にしか無く、
--   ［カレンダー］タブの印から選ぶと**休暇の全部の日**が変わっていた。
-- 決めたこと：
--   ・［シフト調整］タブ（1日ずつ）に［調整不要］を足す。**今ある歯止めつきの関数 shift_adjust_set_status に乗せる**
--     （お願いを送ったあと・人が決まったあと・閉じた場・自分の休み は今までどおり断る）
--   ・場の状態の種類は増やさない：調整不要＝ status 'no_change' ＋ 印 not_needed=true
--   ・休暇の列は日ごとの場から決める：全部の場が「変更なし」かつ全部に印 → 'not_needed'（1つでも印なし → 'no_change'）
--   ・［カレンダー］タブの印は見るだけにする（画面）。受理のときに［必要］［調整不要］を選べるようにする（画面）。
--     受理で 'not_needed' が入った休暇は、場が生まれるときに印つきで生まれる（recompute の引き継ぎ）
--
-- 🚨 4つの関数は**本番の実定義（pg_get_functiondef・2026-09-28 取得）から起こした**。差分は「2026-09-28」の注記の行だけ
-- 🚨 set_leave_shift_adjust は画面から呼ばれなくなる。開いたままの画面のために2週間残し、そのあと消す（計画 手順9(d)）

-- 1. 印の列
alter table public.shift_adjust_slots
  add column if not exists not_needed boolean not null default false;
comment on column public.shift_adjust_slots.not_needed is
  '調整不要の印（2026-09-28）。status=''no_change'' のときだけ true になり得る（それ以外の状態ではトリガーが false に戻す）';

-- 2. 「変更なし」以外になったら印を外す（印だけが残らないように。どの関数から状態を変えても効く）
create or replace function public.trg_shift_adjust_slot_not_needed()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.status is distinct from 'no_change' then
    new.not_needed := false;
  end if;
  return new;
end;
$$;
revoke execute on function public.trg_shift_adjust_slot_not_needed() from public, anon, authenticated;
drop trigger if exists trg_shift_adjust_slot_not_needed on public.shift_adjust_slots;
create trigger trg_shift_adjust_slot_not_needed
  before insert or update on public.shift_adjust_slots
  for each row execute function public.trg_shift_adjust_slot_not_needed();

-- 3. 場 → 休暇 の同期のきっかけに「印の変化」を足す（「変更なし」⇔「調整不要」は状態が変わらないため）
drop trigger if exists trg_zz_shift_adjust_to_leave on public.shift_adjust_slots;
create trigger trg_zz_shift_adjust_to_leave
  after update on public.shift_adjust_slots
  for each row
  when ((old.status is distinct from new.status)
     or (old.cause_leave_request_id is distinct from new.cause_leave_request_id)
     or (old.not_needed is distinct from new.not_needed))   -- 2026-09-28
  execute function public.trg_shift_adjust_to_leave();

-- 4. ［シフト調整］タブの対応の選択（本番の実定義から）
CREATE OR REPLACE FUNCTION public.shift_adjust_set_status(p_slot_id uuid, p_status text)
 RETURNS TABLE(ok boolean, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_is_admin boolean;
  v_slot     shift_adjust_slots%rowtype;
  v_has_assign boolean;
  v_target   text;      -- 2026-09-28：実際に入れる状態（調整不要は 'no_change'）
  v_flag     boolean;   -- 2026-09-28：調整不要の印
begin
  if p_status not in ('pending', 'working', 'no_change', 'not_needed') then   -- 2026-09-28：not_needed を足した
    return query select false, '状態の値が正しくありません'::text;
    return;
  end if;
  v_target := case when p_status = 'not_needed' then 'no_change' else p_status end;   -- 2026-09-28
  v_flag   := (p_status = 'not_needed');                                               -- 2026-09-28

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

  select exists (select 1 from shift_adjust_assignments a where a.slot_id = p_slot_id)
    into v_has_assign;
  if v_has_assign then
    return query select false, 'すでに出勤する人が決まっています。先に「決定を取り消す」から片付けてください'::text;
    return;
  end if;

  if v_slot.status in ('closed_past', 'cause_cancelled') then
    return query select false, 'この場はもう閉じています（過ぎた日、または休みが取り消されました）'::text;
    return;
  end if;

  -- 🚨 2026-09-14：出勤のお願いを送った場は、状態を変えさせない（同じ状態への押し直しは通す）。
  --    変えると、パートの返事の画面が「現在調整中です」のまま残る
  -- 2026-09-28：「変更なし」⇔「調整不要」の切り替えも変更として扱う（印の比較を足した）
  if (v_slot.status is distinct from v_target or v_slot.not_needed is distinct from v_flag)
     and exists (select 1 from shift_adjust_part_requests r where r.slot_id = p_slot_id) then
    return query select false, '出勤のお願いを送ったため、選び直せません。決定するか、お願いの返事を待ってください'::text;
    return;
  end if;

  update shift_adjust_slots s
     set status     = v_target,
         not_needed = v_flag,   -- 2026-09-28
         -- 🚨 「誰がやったか」は確認済み（変更なし）のときだけ残す。
         --    調整中は「まだ決めていない」ので、決めた人を書かない
         decided_by = case when v_target = 'no_change' then auth.uid() else null end,
         decided_at = case when v_target = 'no_change' then now() else null end,
         updated_at = now()
   where s.id = p_slot_id;

  return query select true, ''::text;
end $function$;

-- 5. 休暇まるごとの古いボタン（画面からは呼ばれなくなる。2週間後に消す）。本番の実定義から
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
           not_needed  = (p_status = 'not_needed'),   -- 2026-09-28：調整不要は印を付ける
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

-- 6. 場 → 休暇 の同期（本番の実定義から）
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
           -- 2026-09-28：「変更なし」の場が全部「調整不要」の印つきなら 'not_needed'、1つでも印なしなら 'no_change'
           when count(*) filter (where s.status = 'no_change')              > 0 then
             case when count(*) filter (where s.status = 'no_change' and not s.not_needed) = 0
                  then 'not_needed' else 'no_change' end
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
  -- 2026-09-28：「調整不要のあいだは確認済で上書きしない」の条件は外した。
  --   調整不要は場の印で持つようになり、場から正しく決まるため（残すと［現行シフトで対応］に切り替えても休暇が調整不要のまま）
  update leave_requests lr
     set shift_adjust_status = v_new,
         shift_adjusted_at   = case when v_new = 'pending' then null else coalesce(v_at, now()) end,
         shift_adjusted_by   = case when v_new = 'pending' then null else v_by end
   where lr.id = p_leave_id
     and lr.shift_adjust_status is distinct from v_new;
end $function$;

-- 7. 場を作る・数え直す（本番の実定義から）。生まれるときに休暇の「調整不要」「誰がいつ」を引き継ぐ
CREATE OR REPLACE FUNCTION public.shift_adjust_recompute(p_user_id uuid, p_date date)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_leave_id     uuid;
  v_leave_old    text;
  v_leave_by     uuid;          -- 2026-09-28
  v_leave_at     timestamptz;   -- 2026-09-28
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
  select lr.id, lr.shift_adjust_status, lr.shift_adjusted_by, lr.shift_adjusted_at   -- 2026-09-28：誰がいつ も読む
    into v_leave_id, v_leave_old, v_leave_by, v_leave_at
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

    -- 2026-09-28：調整不要なら印つきで生まれる。変更なし・調整不要は「誰がいつ」も休暇から写す（カレンダーの印に出すため）
    insert into shift_adjust_slots
      (target_user_id, target_date, cause,
       cause_leave_request_id, cause_attendance_exception_id, status,
       not_needed, decided_by, decided_at)
    values
      (p_user_id, p_date, v_cause, v_leave_id, v_absent_id, v_seed,
       (v_seed = 'no_change' and v_leave_old = 'not_needed'),
       case when v_seed = 'no_change' then v_leave_by end,
       case when v_seed = 'no_change' then v_leave_at end)
    on conflict (target_user_id, target_date) do nothing;
    return;
  end if;

  -- (5) すでにある場：きっかけを今の事実に合わせる
  select exists (select 1 from shift_adjust_assignments a where a.slot_id = v_slot_id)
    into v_has_assign;

  -- 2026-09-28：受理のときに選んだ「調整不要」を、すでにある場にも効かせる（v_revive_nn）。
  --   ①いちど消えた休みが戻った場（cause_cancelled）で割り当てが無い
  --   ②手つかず（pending・割り当て無し）の場に、調整不要の休暇が付いた（同じ日の欠勤の場など）
  --   のどちらかで休暇が 'not_needed' なら、「変更なし＋印」で立ち上げる。
  --   🚨 これが無いと、場が pending のまま同期が休暇の列を「未」で上書きし、選んだ調整不要が黙って消える
  update shift_adjust_slots s
     set cause                          = v_cause,
         cause_leave_request_id         = v_leave_id,
         cause_attendance_exception_id  = v_absent_id,
         -- 🚨 状態は原則そのまま。**いちど消えた休みが戻ったときだけ**呼び戻す。
         --    割り当てが残っていれば decided に、無ければ pending に
         status = case when not v_has_assign and v_leave_old = 'not_needed'
                            and s.status in ('cause_cancelled', 'pending')
                       then 'no_change'   -- 2026-09-28
                       when s.status = 'cause_cancelled'
                       then (case when v_has_assign then 'decided' else 'pending' end)
                       else s.status
                  end,
         not_needed = case when not v_has_assign and v_leave_old = 'not_needed'
                                and s.status in ('cause_cancelled', 'pending')
                           then true else s.not_needed end,   -- 2026-09-28
         decided_by = case when not v_has_assign and v_leave_old = 'not_needed'
                                and s.status in ('cause_cancelled', 'pending')
                           then v_leave_by else s.decided_by end,   -- 2026-09-28
         decided_at = case when not v_has_assign and v_leave_old = 'not_needed'
                                and s.status in ('cause_cancelled', 'pending')
                           then v_leave_at else s.decided_at end,   -- 2026-09-28
         updated_at = now()
   where s.id = v_slot_id;
end $function$;

-- 🚨 create or replace は権限を保つが、念のため anon を明示的に外す（set 2つは今までどおり authenticated に許可）
revoke execute on function public.shift_adjust_set_status(uuid, text) from anon;
revoke execute on function public.set_leave_shift_adjust(uuid, text) from anon;
revoke execute on function public.shift_adjust_sync_leave_status(uuid) from anon;
revoke execute on function public.shift_adjust_recompute(uuid, date) from anon;

-- 8. 今ある分：休暇が「調整不要」で、場が「変更なし」なら印を付ける
--    （印が付くと同期が動くが、その休暇の場が全部これなら 'not_needed' のまま＝値は変わらない）
update public.shift_adjust_slots s
   set not_needed = true
  from public.leave_requests lr
 where lr.id = s.cause_leave_request_id
   and lr.shift_adjust_status = 'not_needed'
   and s.status = 'no_change'
   and not s.not_needed;
