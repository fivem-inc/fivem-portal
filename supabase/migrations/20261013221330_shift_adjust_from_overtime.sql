-- 残業申請の終日（時間外調整休・振替休日・欠勤）からもシフト調整の場を作る（2026-10-13 ユーザー確定）
-- ・10/16 から休暇申請の「時間調整」「調整休」を残業申請にまとめる。そのままだと、残業で休む日に上長へ
--   シフト調整の知らせ（毎朝のまとめ・シフト調整タブ）が出なくなるため、休暇と同じ動きにする
-- ・場を作るのは受理済み（confirmed／request_confirmed）だけ（休暇がマネージャー受理で作るのと同じ）。取消・差し戻し・日付の変更は数え直す
-- ・きっかけ（cause）に chosei_off／furikae_off／ot_absence を足す（場を見る人が残業の表を読めないことがあるので種類を場に持つ）
-- ・受理のときの「シフト調整：必要／調整不要」：overtime_reports.shift_adjust_not_needed（受理の Edge Function が受理と同じ1回で書く）
-- ・shift_adjust_recompute は本番の実定義（pg_get_functiondef）から起こし、残業の終日の枝だけを足した
-- 🚨 leave_auto（休暇の調整休から自動でできる残業の行）は除く＝元の休暇が場を作る。同じ日に両方あっても場は1つ（休暇が優先）
begin;

alter table public.shift_adjust_slots drop constraint if exists shift_adjust_slots_cause_check;
alter table public.shift_adjust_slots add constraint shift_adjust_slots_cause_check
  check (cause in ('leave', 'absent', 'chosei_off', 'furikae_off', 'ot_absence'));
alter table public.shift_adjust_slots
  add column if not exists cause_overtime_report_id uuid references public.overtime_reports(id) on delete set null;
comment on column public.shift_adjust_slots.cause_overtime_report_id is '残業申請の終日（時間外調整休・振替休日・欠勤）がきっかけのとき、その申請（2026-10-13）';

alter table public.overtime_reports
  add column if not exists shift_adjust_not_needed boolean not null default false,
  add column if not exists shift_adjusted_by uuid references public.profiles(id) on delete set null,
  add column if not exists shift_adjusted_at timestamptz;
comment on column public.overtime_reports.shift_adjust_not_needed is
  '終日（時間外調整休・振替休日・欠勤）を受理するときに「シフト調整：調整不要」を選んだか（2026-10-13）。シフト調整の場を「変更なし＋調整不要」で作る';

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
  v_ot_id        uuid;          -- 2026-10-13：残業申請の終日（時間外調整休・振替休日・欠勤）
  v_ot_type      text;
  v_ot_nn        boolean;
  v_ot_by        uuid;
  v_ot_at        timestamptz;
  v_nn           boolean;       -- 受理のときに選んだ「調整不要」（休暇が優先・無ければ残業）
  v_nn_by        uuid;
  v_nn_at        timestamptz;
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

  -- (2.5) その日の残業申請の終日（受理済み）。2026-10-13：休暇の調整休を残業申請にまとめるため。
  --       🚨 leave_auto（休暇の調整休から自動でできる行）は除く＝元の休暇が場を作る（二重にしない）
  select o.id,
         case when 'chosei_off' = any (o.application_types) then 'chosei_off'
              when 'furikae_off' = any (o.application_types) then 'furikae_off'
              else 'ot_absence' end,
         coalesce(o.shift_adjust_not_needed, false), o.shift_adjusted_by, o.shift_adjusted_at
    into v_ot_id, v_ot_type, v_ot_nn, v_ot_by, v_ot_at
    from overtime_reports o
   where o.applicant_id = p_user_id
     and o.work_date = p_date
     and o.entry_type = 'manual'
     and o.status in ('confirmed', 'request_confirmed')
     and o.application_types && array['chosei_off', 'furikae_off', 'absence']::text[]
   order by o.created_at nulls last, o.id
   limit 1;

  -- 受理のときの「調整不要」：休暇があれば休暇の選択、無ければ残業の選択
  v_nn    := case when v_leave_id is not null then (v_leave_old = 'not_needed') else coalesce(v_ot_nn, false) end;
  v_nn_by := case when v_leave_id is not null then v_leave_by else v_ot_by end;
  v_nn_at := case when v_leave_id is not null then v_leave_at else v_ot_at end;

  select s.id, s.status
    into v_slot_id, v_slot_status
    from shift_adjust_slots s
   where s.target_user_id = p_user_id
     and s.target_date = p_date;

  -- (3) 休みがもう無い＝きっかけが消えた
  if v_leave_id is null and v_absent_id is null and v_ot_id is null then
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
  -- 2026-10-13：優先は 休暇 → 残業申請の終日 → 欠勤
  v_cause := case when v_leave_id is not null then 'leave'
                  when v_ot_id is not null then v_ot_type
                  else 'absent' end;

  -- (4) まだ場が無い＝新しく作る
  if v_slot_id is null then
    -- 🚨🚨 生まれたときの状態は、**古い列から引き継ぐ**。
    --    いつも pending で作ると、すでに「調整済み」にしてある休暇（本番に7件）を
    --    触っただけで場が pending で生まれ、逆向きの同期で古い列が未調整に戻り、
    --    カレンダーの印が巻き戻る。手順3の対応（adjusted→decided）と同じ向きで揃える
    v_seed := case
                when v_leave_id is not null then
                  case v_leave_old
                    when 'adjusted'  then 'decided'
                    when 'no_change' then 'no_change'
                    when 'not_needed' then 'no_change'   -- 調整不要（2026-09-19）
                    else                  'pending'
                  end
                when v_nn then 'no_change'               -- 残業申請の受理で「調整不要」（2026-10-13）
                else 'pending'
              end;

    -- 過ぎた日は知らせない（設計書 1.）。🚨 閉じた状態で作るので逆向きの同期もしない
    --    ＝古い列は今までどおり「未調整」のまま。カレンダーの印は変わらない
    if v_seed = 'pending' and p_date < v_today then
      v_seed := 'closed_past';
    end if;

    -- 2026-09-28：調整不要なら印つきで生まれる。変更なし・調整不要は「誰がいつ」も休暇から写す（カレンダーの印に出すため）
    insert into shift_adjust_slots
      (target_user_id, target_date, cause,
       cause_leave_request_id, cause_attendance_exception_id, cause_overtime_report_id, status,
       not_needed, decided_by, decided_at)
    values
      (p_user_id, p_date, v_cause, v_leave_id, v_absent_id, v_ot_id, v_seed,
       (v_seed = 'no_change' and v_nn),
       case when v_seed = 'no_change' then v_nn_by end,
       case when v_seed = 'no_change' then v_nn_at end)
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
         cause_overtime_report_id       = v_ot_id,   -- 2026-10-13
         -- 🚨 状態は原則そのまま。**いちど消えた休みが戻ったときだけ**呼び戻す。
         --    割り当てが残っていれば decided に、無ければ pending に
         status = case when not v_has_assign and v_nn
                            and s.status in ('cause_cancelled', 'pending')
                       then 'no_change'   -- 2026-09-28
                       when s.status = 'cause_cancelled'
                       then (case when v_has_assign then 'decided' else 'pending' end)
                       else s.status
                  end,
         not_needed = case when not v_has_assign and v_nn
                                and s.status in ('cause_cancelled', 'pending')
                           then true else s.not_needed end,   -- 2026-09-28
         decided_by = case when not v_has_assign and v_nn
                                and s.status in ('cause_cancelled', 'pending')
                           then v_nn_by else s.decided_by end,   -- 2026-09-28
         decided_at = case when not v_has_assign and v_nn
                                and s.status in ('cause_cancelled', 'pending')
                           then v_nn_at else s.decided_at end,   -- 2026-09-28
         updated_at = now()
   where s.id = v_slot_id;
end $function$;

-- 残業申請の行が変わったら、その人・その日（変更前と変更後）を数え直す
create or replace function public.trg_shift_adjust_from_overtime()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  begin
    if tg_op in ('UPDATE', 'DELETE') then
      perform public.shift_adjust_recompute(old.applicant_id, old.work_date);
    end if;
    if tg_op = 'INSERT'
       or (tg_op = 'UPDATE' and (old.applicant_id is distinct from new.applicant_id or old.work_date is distinct from new.work_date)) then
      perform public.shift_adjust_recompute(new.applicant_id, new.work_date);
    end if;
  exception when others then
    raise warning '[shift_adjust] 残業申請からの作業場の更新に失敗しました: %', sqlerrm;
  end;
  return null;
end $function$;

revoke execute on function public.trg_shift_adjust_from_overtime() from public;
revoke execute on function public.trg_shift_adjust_from_overtime() from anon;
revoke execute on function public.trg_shift_adjust_from_overtime() from authenticated;

drop trigger if exists trg_zz_shift_adjust_ot_ins on public.overtime_reports;
drop trigger if exists trg_zz_shift_adjust_ot_upd on public.overtime_reports;
drop trigger if exists trg_zz_shift_adjust_ot_del on public.overtime_reports;
create trigger trg_zz_shift_adjust_ot_ins after insert on public.overtime_reports
  for each row
  when (new.entry_type = 'manual' and new.status in ('confirmed', 'request_confirmed')
        and new.application_types && array['chosei_off', 'furikae_off', 'absence']::text[])
  execute function public.trg_shift_adjust_from_overtime();
create trigger trg_zz_shift_adjust_ot_upd after update on public.overtime_reports
  for each row
  when ((old.application_types && array['chosei_off', 'furikae_off', 'absence']::text[]
         or new.application_types && array['chosei_off', 'furikae_off', 'absence']::text[])
        and (old.status is distinct from new.status
             or old.work_date is distinct from new.work_date
             or old.applicant_id is distinct from new.applicant_id
             or old.application_types is distinct from new.application_types
             or old.entry_type is distinct from new.entry_type
             or old.shift_adjust_not_needed is distinct from new.shift_adjust_not_needed))
  execute function public.trg_shift_adjust_from_overtime();
create trigger trg_zz_shift_adjust_ot_del after delete on public.overtime_reports
  for each row
  when (old.entry_type = 'manual' and old.application_types && array['chosei_off', 'furikae_off', 'absence']::text[])
  execute function public.trg_shift_adjust_from_overtime();

-- 今ある分の穴埋め（今日以降の受理済みの終日）
do $$
declare r record;
begin
  for r in select applicant_id, work_date from overtime_reports
            where entry_type = 'manual' and status in ('confirmed', 'request_confirmed')
              and application_types && array['chosei_off', 'furikae_off', 'absence']::text[]
              and work_date >= (now() at time zone 'Asia/Tokyo')::date
  loop
    perform public.shift_adjust_recompute(r.applicant_id, r.work_date);
  end loop;
end $$;

commit;
