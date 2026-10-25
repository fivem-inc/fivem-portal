-- 振替休日に「実績を報告する」を付ける 段1（DB）。計画：docs/計画-振替休日の実績報告.md（2026-10-26 ユーザー確定）
-- ・振替元の日がまだ来ていない振替休日は「事前申請 受理済み」→ 振替元の日のあとに実績報告 → 確定（ふつうの事前申請と同じ）
-- ・新しい動きは app_settings 'furikae_report_on' で切り替える。🚨 この migration は切り替えを false で入れる＝今までと同じ動き
--   画面が本番に出てから true にし、今ある振替休日（振替元が今日以降）を移す
-- ・関数は本番の実定義から起こした（shift_adjust_recompute・overtime_confirm_as_planned・notify_overtime_fullday_fyi）

-- ① 切り替え（初めはオフ）
insert into public.app_settings (key, value) values ('furikae_report_on', 'false'::jsonb)
on conflict (key) do nothing;

create or replace function public.furikae_report_switch_on()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select coalesce((select value from public.app_settings where key = 'furikae_report_on') = 'true'::jsonb, false);
$$;
revoke execute on function public.furikae_report_switch_on() from public;
revoke execute on function public.furikae_report_switch_on() from anon;
grant execute on function public.furikae_report_switch_on() to authenticated, service_role;

-- ② 列
alter table public.overtime_reports
  add column if not exists furikae_report_needed boolean not null default false,
  add column if not exists furikae_planned jsonb,
  add column if not exists furikae_not_worked_at timestamptz,
  add column if not exists furikae_not_worked_reason text;
comment on column public.overtime_reports.furikae_report_needed is
  '振替休日で、出したとき振替元の日がまだ来ていなかった（＝あとで振替元の実績を報告する）。DB のトリガー trg_furikae_report_state が決める（画面からは変えられない）';
comment on column public.overtime_reports.furikae_planned is
  '振替元の予定（実績報告の直前の値）。事前受理 → 実績報告／確定 の瞬間にトリガーが写す。受理を省く判定と受理ページの「予定」に使う';
comment on column public.overtime_reports.furikae_not_worked_at is
  '振替元の日に勤務しなかった（本人が［この日は勤務しませんでした］を押した）日時。段5で使う';

-- ③ 印・状態・予定の控えを決めるトリガー（画面・表入力・まとめて申請・Edge Function の全部がここを通る）
create or replace function public.trg_furikae_report_state()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_is    boolean := new.entry_type = 'manual'
                     and 'furikae_off' = any (coalesce(new.application_types, '{}'))
                     and new.furikae_origin_date is not null;
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
begin
  -- 今ある行を移すとき（移行の SQL の中だけ立てる印）
  if coalesce(current_setting('app.furikae_migrate', true), '') = 'on' then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.furikae_planned := null;
    new.furikae_not_worked_at := null;
    new.furikae_not_worked_reason := null;
    new.furikae_report_needed := v_is and public.furikae_report_switch_on() and new.furikae_origin_date >= v_today;
    -- 古い画面（端末の写し）が自己受理で「確認済み」を入れてきたときも、事前受理に直す
    if new.furikae_report_needed and new.status = 'confirmed' then
      new.status := 'request_confirmed';
      new.request_confirmed_at := coalesce(new.request_confirmed_at, new.confirmed_at, now());
      new.confirmed_by := null;
      new.confirmed_at := null;
    end if;
    return new;
  end if;

  -- UPDATE
  if not v_is then
    new.furikae_report_needed := false;
  elsif old.request_confirmed_at is null and new.request_confirmed_at is null
        and (new.furikae_origin_date is distinct from old.furikae_origin_date
             or (old.status = 'returned' and new.status = 'requested')) then
    -- まだ事前受理されていない申請の出し直し・振替元の日の変更だけ、計算し直す
    new.furikae_report_needed := public.furikae_report_switch_on() and new.furikae_origin_date >= v_today;
  else
    new.furikae_report_needed := old.furikae_report_needed;
  end if;

  -- 予定の控え：事前受理 → 実績報告／確定 の瞬間だけ写す。それ以外は変えさせない（本人は行を書き換えられるため）
  if old.furikae_report_needed and old.status = 'request_confirmed' and new.status in ('reported', 'confirmed') then
    new.furikae_planned := jsonb_build_object(
      'date', old.furikae_origin_date,
      'location', old.furikae_origin_location,
      'start', old.furikae_origin_start,
      'end', old.furikae_origin_end,
      'break_minutes', old.furikae_origin_break_minutes,
      'labor_minutes', old.furikae_origin_labor_minutes,
      'diff_minutes', old.diff_minutes);
  else
    new.furikae_planned := old.furikae_planned;
  end if;

  -- 勤務しなかった印は、サーバー（Edge Function）だけが付けられる（段5）
  if auth.uid() is not null then
    new.furikae_not_worked_at := old.furikae_not_worked_at;
    new.furikae_not_worked_reason := old.furikae_not_worked_reason;
  end if;
  return new;
end;
$$;
revoke execute on function public.trg_furikae_report_state() from public;
revoke execute on function public.trg_furikae_report_state() from anon;
revoke execute on function public.trg_furikae_report_state() from authenticated;

drop trigger if exists trg_furikae_report_state on public.overtime_reports;
-- 🚨 名前の順で trg_enforce_overtime_self_confirm（自己受理の見張り）より後に動く＝見張りは画面が送った status を見る
create trigger trg_furikae_report_state
  before insert or update on public.overtime_reports
  for each row execute function public.trg_furikae_report_state();

-- ④ 休む日と振替元の日は同じ給与期間だけ（ユーザー確定・文は案C）。切り替えがオンのときだけ
create or replace function public.enforce_furikae_same_period()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_pw date; v_po date;
begin
  if new.entry_type is distinct from 'manual' or new.status = 'cancelled'
     or not ('furikae_off' = any (coalesce(new.application_types, '{}')))
     or new.furikae_origin_date is null then
    return new;
  end if;
  -- 日付・種別が変わらない書き換え（受理・報告など）は見ない
  if tg_op = 'UPDATE' and old.status is distinct from 'cancelled'
     and new.work_date is not distinct from old.work_date
     and new.furikae_origin_date is not distinct from old.furikae_origin_date
     and new.application_types is not distinct from old.application_types then
    return new;
  end if;
  if not public.furikae_report_switch_on() then
    return new;
  end if;
  v_pw := public.calc_pay_period_start(new.work_date);
  v_po := public.calc_pay_period_start(new.furikae_origin_date);
  if v_pw <> v_po then
    raise exception 'FURIKAE_PERIOD|休む日（%）は %〜% の給与期間、振替元の日（%）は %〜% の給与期間です。振替休日は同じ期間の中でだけ出せます。',
      to_char(new.work_date, 'FMMM/FMDD'),
      to_char(v_pw, 'FMMM/FMDD'), to_char((v_pw + interval '1 month' - interval '1 day')::date, 'FMMM/FMDD'),
      to_char(new.furikae_origin_date, 'FMMM/FMDD'),
      to_char(v_po, 'FMMM/FMDD'), to_char((v_po + interval '1 month' - interval '1 day')::date, 'FMMM/FMDD')
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke execute on function public.enforce_furikae_same_period() from public;
revoke execute on function public.enforce_furikae_same_period() from anon;
revoke execute on function public.enforce_furikae_same_period() from authenticated;

drop trigger if exists trg_enforce_furikae_same_period on public.overtime_reports;
create trigger trg_enforce_furikae_same_period
  before insert or update of work_date, furikae_origin_date, application_types, status, entry_type on public.overtime_reports
  for each row execute function public.enforce_furikae_same_period();

-- ⑤ シフト調整：振替休日を報告・差し戻ししても休みのまま（(2.5) の条件だけ変えた）
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
  v_pt_id        uuid;          -- 2026-10-20：遅出・早退・勤務地変更（シフト調整「必要」を選んだもの）
  v_pt_cover     jsonb;
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
     -- 🚨 2026-10-26：振替休日の実績報告（reported）・差し戻し（returned）でも休みのまま。一度受理された（request_confirmed_at）かつ取消・却下でない
     and (o.status in ('confirmed', 'request_confirmed')
          or (o.request_confirmed_at is not null and o.status not in ('cancelled', 'rejected')))
     and o.application_types && array['chosei_off', 'furikae_off', 'absence']::text[]
   order by o.created_at nulls last, o.id
   limit 1;

  -- (2.6) その日の遅出・早退・勤務地変更（2026-10-20）。受理のとき・受理済みの欄で「必要」を選んだもの（shift_adjust_needed）だけ。
  --       🚨 判定は「一度受理された（request_confirmed_at）かつ取り消されていない」。status を見ると、実績報告（reported）で
  --          相談が「取り消されました」に変わってしまう。終日の休みを含む申請は (2.5) が受け持つ
  select o.id into v_pt_id
    from overtime_reports o
   where o.applicant_id = p_user_id
     and o.work_date = p_date
     and o.entry_type = 'manual'
     and o.shift_adjust_needed
     and o.request_confirmed_at is not null
     and o.status not in ('cancelled', 'rejected')
     and o.application_types && array['location_change', 'late_start_adj', 'tardiness', 'early_end_adj', 'early_leave']::text[]
     and not (o.application_types && array['chosei_off', 'furikae_off', 'absence']::text[])
   order by o.created_at nulls last, o.id
   limit 1;
  if v_pt_id is not null then
    v_pt_cover := public.ot_partial_cover(v_pt_id);   -- 予定の時間帯がまだ無いときは null（前の値を残す）
  end if;

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
  if v_leave_id is null and v_absent_id is null and v_ot_id is null and v_pt_id is null then
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
  -- 2026-10-13：優先は 休暇 → 残業申請の終日 → 欠勤 → 2026-10-20：遅出・早退・勤務地変更（一部の時間は終日に含まれるので最後）
  v_cause := case when v_leave_id is not null then 'leave'
                  when v_ot_id is not null then v_ot_type
                  when v_absent_id is not null then 'absent'
                  else 'ot_partial' end;

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
       not_needed, decided_by, decided_at,
       cover_segments, cover_location, cover_types, cover_note)   -- 2026-10-20
    values
      (p_user_id, p_date, v_cause, v_leave_id, v_absent_id, coalesce(v_ot_id, v_pt_id), v_seed,
       (v_seed = 'no_change' and v_nn),
       case when v_seed = 'no_change' then v_nn_by end,
       case when v_seed = 'no_change' then v_nn_at end,
       v_pt_cover->'segments', v_pt_cover->>'location',
       case when v_pt_cover is not null then array(select jsonb_array_elements_text(v_pt_cover->'types')) end,
       v_pt_cover->>'note')
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
         cause_overtime_report_id       = coalesce(v_ot_id, v_pt_id),   -- 2026-10-13・2026-10-20
         -- 2026-10-20：いない時間などの写し。予定の時間帯が読めないとき（null）は前の値を残す
         cover_segments = coalesce(v_pt_cover->'segments', s.cover_segments),
         cover_location = coalesce(v_pt_cover->>'location', s.cover_location),
         cover_types    = case when v_pt_cover is not null then array(select jsonb_array_elements_text(v_pt_cover->'types')) else s.cover_types end,
         cover_note     = case when v_pt_cover is not null then v_pt_cover->>'note' else s.cover_note end,
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

-- ⑥ 「振替休日が受理されました」のお知らせ：振替元の日が来ていないものは事前受理のときに1回
CREATE OR REPLACE FUNCTION public.notify_overtime_fullday_fyi()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_site_on boolean; v_site_rcp text; v_push_on boolean; v_rcp jsonb;
  v_label text; v_name text; v_msg text; r record;
begin
  if new.entry_type is distinct from 'manual' then return new; end if;
  if new.furikae_report_needed then
    -- 2026-10-26：振替元の日がまだ来ていない振替休日は、事前受理になったとき（新しく入れた／申請中から）だけ。確定のときは送らない
    --   🚨 今ある行の移行（確認済み → 事前受理）でも送らない（old.status が requested でないため）
    if new.status is distinct from 'request_confirmed' then return new; end if;
    if tg_op = 'UPDATE' and old.status is distinct from 'requested' then return new; end if;
  else
    if new.status is distinct from 'confirmed' then return new; end if;
    if tg_op = 'UPDATE' and old.status is not distinct from 'confirmed' then return new; end if;
  end if;
  if not (coalesce(new.application_types, '{}') && array['chosei_off', 'furikae_off', 'absence']) then return new; end if;

  begin
    select ns.enabled, ns.recipient into v_site_on, v_site_rcp
      from notification_settings ns where ns.event_key = 'leave:approved_fyi' and ns.channel = 'site';
    -- 🚨 休暇と同じ：設定が無い・OFF なら送らない
    if v_site_on is not true then return new; end if;
    select ns.enabled into v_push_on
      from notification_settings ns where ns.event_key = 'leave:approved_fyi' and ns.channel = 'push';
    begin
      v_rcp := coalesce(nullif(v_site_rcp, '')::jsonb, '{}'::jsonb);
    exception when others then v_rcp := '{}'::jsonb;
    end;

    v_label := case
      when 'chosei_off' = any(new.application_types) then '時間外調整休'
      when 'furikae_off' = any(new.application_types) then '振替休日'
      else '欠勤' end;
    select coalesce(name, '') into v_name from profiles where id = new.applicant_id;
    v_msg := '🕐 ' || v_label || 'が受理されました「' || v_name || '（' || extract(month from new.work_date)::int || '/' || extract(day from new.work_date)::int || '（' || (array['日','月','火','水','木','金','土'])[extract(dow from new.work_date)::int + 1] || '））」';

    for r in
      select rid as user_id from public.resolve_role_recipients(new.applicant_id, v_rcp) rid
       where rid <> new.applicant_id
    loop
      insert into notifications (user_id, message, sub_message, source_type, event_key, reference_id)
      values (r.user_id, v_msg, null, 'overtime:fullday_fyi',
              case when coalesce(v_push_on, false) then 'overtime:fullday_fyi' end,
              new.work_date::text);
    end loop;
  exception when others then
    -- 🚨 お知らせが送れなくても受理そのものは止めない
    raise warning '[notify_overtime_fullday_fyi] お知らせを送れませんでした: %', sqlerrm;
  end;
  return new;
end $function$;

-- ⑦ 予定どおりの実績報告は受理なしで確定：振替休日は振替元の値と予定の控えを比べる・予定の終わりを過ぎてから
CREATE OR REPLACE FUNCTION public.overtime_confirm_as_planned(p_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_r     overtime_reports%rowtype;
  v_snap  jsonb;
  v_name  text;
  v_site  boolean;
  v_same  boolean;
  v_end   timestamp;
  v_bell_date date;
begin
  select * into v_r from overtime_reports where id = p_id for update;
  if not found then return false; end if;
  -- 本人が、たったいま出した実績報告だけ
  if v_r.applicant_id is distinct from auth.uid() then return false; end if;
  if v_r.entry_type <> 'manual' or v_r.status <> 'reported' then return false; end if;
  -- 事前申請を上長が受理している（自己受理の人は今までどおり別の道で確定する）
  if v_r.request_confirmed_at is null or v_r.reviewer_id is null or v_r.reviewer_id = v_r.applicant_id then return false; end if;

  v_bell_date := v_r.work_date;
  if v_r.furikae_report_needed then
    -- 2026-10-26 振替休日：振替元の値が予定の控え（furikae_planned・トリガーが写す）と同じで、振替元の予定の終わりを過ぎていること
    if v_r.furikae_planned is null
       or (v_r.furikae_planned->>'date') is distinct from v_r.furikae_origin_date::text
       or coalesce(v_r.furikae_planned->>'location', '') <> coalesce(v_r.furikae_origin_location, '')
       or (v_r.furikae_planned->>'start') is distinct from v_r.furikae_origin_start::text
       or (v_r.furikae_planned->>'end') is distinct from v_r.furikae_origin_end::text
       or (v_r.furikae_planned->>'break_minutes')::int is distinct from v_r.furikae_origin_break_minutes
       or (v_r.furikae_planned->>'diff_minutes')::int is distinct from v_r.diff_minutes
       or v_r.furikae_not_worked_at is not null
       or v_r.furikae_origin_start is null or v_r.furikae_origin_end is null then
      return false;
    end if;
    v_end := v_r.furikae_origin_date + v_r.furikae_origin_end;
    if v_r.furikae_origin_end <= v_r.furikae_origin_start then v_end := v_end + interval '1 day'; end if;
    if now() < (v_end at time zone 'Asia/Tokyo') then return false; end if;
    v_bell_date := v_r.furikae_origin_date;
  else
  -- 実績報告の直前の控え（状態が「事前申請 受理済み」だったもの）
  select h.snapshot into v_snap
    from overtime_report_history h
   where h.report_id = p_id and h.changed_by = auth.uid()
   order by h.changed_at desc
   limit 1;
  if v_snap is null or v_snap->>'status' <> 'request_confirmed' then return false; end if;

  -- 休憩・勤務地・種別が予定のときと同じ
  if coalesce((v_snap->>'break_minutes')::int, -1) <> coalesce(v_r.break_minutes, -1) then return false; end if;
  if coalesce(v_snap->>'location', '') <> coalesce(v_r.location, '') then return false; end if;
  if (select coalesce(array_agg(x order by x), '{}') from jsonb_array_elements_text(coalesce(v_snap->'application_types', '[]'::jsonb)) x)
     <> (select coalesce(array_agg(x order by x), '{}') from unnest(v_r.application_types) x) then
    return false;
  end if;

  -- 時間帯：予定と実績が本数・開始・終了とも同じ（1本以上）
  select (select count(*) from overtime_report_segments where report_id = p_id and phase = 'actual') > 0
     and not exists (
       (select start_min, end_min from overtime_report_segments where report_id = p_id and phase = 'planned'
        except all
        select start_min, end_min from overtime_report_segments where report_id = p_id and phase = 'actual')
       union all
       (select start_min, end_min from overtime_report_segments where report_id = p_id and phase = 'actual'
        except all
        select start_min, end_min from overtime_report_segments where report_id = p_id and phase = 'planned')
     )
    into v_same;
  if not coalesce(v_same, false) then return false; end if;
  end if;

  -- 確認済みにする（この中だけ自己受理の決まりを通す）
  perform set_config('app.ot_as_planned', 'on', true);
  update overtime_reports
     set status = 'confirmed', confirmed_by = v_r.reviewer_id, confirmed_at = now()
   where id = p_id and status = 'reported';
  perform set_config('app.ot_as_planned', 'off', true);

  insert into overtime_report_history (report_id, changed_by, change_summary, snapshot)
  values (p_id, auth.uid(), '予定どおりの実績報告のため、受理を省いて確認済み（事前申請は受理済み）', to_jsonb(v_r));

  -- 上長へベルだけ（プッシュなし）。押しても何も開かないお知らせ
  select enabled into v_site from notification_settings where event_key = 'overtime:new_request' and channel = 'site';
  if coalesce(v_site, true) then
    select name into v_name from profiles where id = v_r.applicant_id;
    insert into notifications (user_id, message, sub_message, source_type, reference_id, event_key, read)
    values (v_r.reviewer_id,
            '🕐 ' || coalesce(v_name, '') || 'さんの実績報告は予定どおりでした（受理は不要です）',
            to_char(v_bell_date, 'YYYY-MM-DD') || '（' || (array['日','月','火','水','木','金','土'])[extract(dow from v_bell_date)::int + 1] || '）',
            null, null, null, false);
  end if;

  return true;
end;
$function$;

revoke execute on function public.overtime_confirm_as_planned(uuid) from anon;
