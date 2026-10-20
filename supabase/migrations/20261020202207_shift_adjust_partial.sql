-- ============================================================
-- 2026-10-20  遅出・早退・勤務地変更でもシフト調整の相談を作れるようにする（段1：DB）
-- ============================================================
-- 計画と決まったことの全部：docs/計画-遅出早退勤務地変更のシフト調整.md（ユーザー確定・UI/UX とシニアエンジニアの2体で2回レビュー）
-- 🚨 この段だけでは運用は変わらない（印 shift_adjust_needed の既定は false・立てる経路＝Edge Function と画面は次の段）
-- 関数 shift_adjust_recompute・shift_adjust_send_digest は 2026-10-20 の本番の実定義（pg_get_functiondef）から起こした。
-- ロールバック手順：
--   drop trigger trg_zz_shift_adjust_pt_ins / _pt_upd / _pt_del on overtime_reports; drop trigger trg_overtime_shift_needed on overtime_reports;
--   drop trigger trg_zz_shift_adjust_ot_segments on overtime_report_segments;
--   shift_adjust_recompute・shift_adjust_send_digest は作業用フォルダ（D ドライブの fivem-work の rollback-20261020-shift-partial）の控えで作り直す。
--   列は残してよい（既定 false・null）。ot_partial の相談があれば先に片付けてから cause の制約を戻す

-- ① 残業申請：シフト調整「必要」の印（遅出・早退・勤務地変更だけで使う・既定 false＝作らない）
--    🚨 shift_adjust_not_needed（終日の休み用・既定 false＝必要）とは向きが逆なので、使い回さない
alter table public.overtime_reports
  add column if not exists shift_adjust_needed boolean not null default false;
comment on column public.overtime_reports.shift_adjust_needed is
  '2026-10-20 遅出・早退・勤務地変更で「シフト調整：必要」を選んだ印。true のとき（受理済み・取り消されていない）シフト調整の相談（cause ot_partial）を作る。立てられるのは受理の Edge Function・自己受理・overtime_set_shift_adjust_needed だけ（見張り enforce_overtime_shift_needed）';

-- ② 相談：きっかけ ot_partial と、いない時間などの写し（相談を見る人は残業申請の表を読めないことがあるため）
alter table public.shift_adjust_slots drop constraint if exists shift_adjust_slots_cause_check;
alter table public.shift_adjust_slots add constraint shift_adjust_slots_cause_check
  check (cause = any (array['leave', 'absent', 'chosei_off', 'furikae_off', 'ot_absence', 'ot_partial']));
alter table public.shift_adjust_slots
  add column if not exists cover_segments jsonb,
  add column if not exists cover_location text,
  add column if not exists cover_types text[],
  add column if not exists cover_note text;
comment on column public.shift_adjust_slots.cover_segments is
  '2026-10-20 ot_partial：代わりが要る時間 [{start:"HH:MM", end:"HH:MM"}]（遅出＝いつものシフトの始まり〜予定の始まり／早退＝予定の終わり〜シフトの終わり／勤務地変更＝シフト全体）';

-- ③ いない時間の計算（1か所）。予定（planned）の時間帯がまだ無いときは null＝呼ぶ側は前の値を残す
create or replace function public.ot_partial_cover(p_report_id uuid)
returns jsonb
language plpgsql stable security definer set search_path to 'public'
as $$
declare
  r          public.overtime_reports%rowtype;
  v_types    text[];
  v_ns       jsonb;
  v_bs       int[] := '{}';
  v_be       int[] := '{}';
  v_s        int;
  v_e        int;
  v_ps       int;
  v_pe       int;
  v_nmin     int;
  v_nmax     int;
  v_segs     jsonb := '[]'::jsonb;
  v_late     boolean;
  v_early    boolean;
  v_loc      boolean;
  i          int;
  v_note     text;
begin
  select * into r from public.overtime_reports where id = p_report_id;
  if r.id is null then return null; end if;
  v_types := array(select unnest(r.application_types) intersect
                   select unnest(array['location_change', 'late_start_adj', 'tardiness', 'early_end_adj', 'early_leave']));
  v_ns := r.normal_shift;
  if v_ns is null or coalesce(v_ns->>'start_time', '') = '' then return null; end if;
  -- いつものシフトの帯（2本シフトは時刻の早い順）
  for i in 1..2 loop
    v_s := case when i = 1 then extract(epoch from (v_ns->>'start_time')::time)::int / 60
                else case when coalesce(v_ns->>'start_time2', '') <> '' then extract(epoch from (v_ns->>'start_time2')::time)::int / 60 end end;
    v_e := case when i = 1 then extract(epoch from (v_ns->>'end_time')::time)::int / 60
                else case when coalesce(v_ns->>'end_time2', '') <> '' then extract(epoch from (v_ns->>'end_time2')::time)::int / 60 end end;
    if v_s is not null and v_e is not null then
      if v_e <= v_s then v_e := v_e + 1440; end if;
      v_bs := v_bs || v_s; v_be := v_be || v_e;
    end if;
  end loop;
  if array_length(v_bs, 1) is null then return null; end if;
  if array_length(v_bs, 1) = 2 and v_bs[2] < v_bs[1] then
    v_bs := array[v_bs[2], v_bs[1]]; v_be := array[v_be[2], v_be[1]];
  end if;
  v_nmin := v_bs[1];
  v_nmax := (select max(x) from unnest(v_be) x);

  v_loc   := 'location_change' = any (v_types);
  v_late  := v_types && array['late_start_adj', 'tardiness'];
  v_early := v_types && array['early_end_adj', 'early_leave'];

  if v_loc then
    -- 勤務地変更：移動の時刻は記録に無いので、いつものシフト全体（決める人が直せる）
    for i in 1..array_length(v_bs, 1) loop
      v_segs := v_segs || jsonb_build_object('start', v_bs[i], 'end', v_be[i]);
    end loop;
    if coalesce(r.location, '') like '%→%' then
      v_note := '移動の時刻は申請に無いため、いつものシフト全体を表示しています';
    end if;
  else
    select min(start_min), max(end_min) into v_ps, v_pe
      from public.overtime_report_segments where report_id = p_report_id and phase = 'planned';
    if v_ps is null then return null; end if;   -- 予定の時間帯がまだ（消す→入れ直すの途中など）
    for i in 1..array_length(v_bs, 1) loop
      if v_late and v_ps > v_bs[i] then
        v_s := v_bs[i]; v_e := least(v_be[i], v_ps);
        if v_e > v_s then v_segs := v_segs || jsonb_build_object('start', v_s, 'end', v_e); end if;
      end if;
      if v_early and v_pe < v_be[i] then
        v_s := greatest(v_bs[i], v_pe); v_e := v_be[i];
        if v_e > v_s then v_segs := v_segs || jsonb_build_object('start', v_s, 'end', v_e); end if;
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'segments', (select coalesce(jsonb_agg(jsonb_build_object(
                    'start', lpad(((x->>'start')::int / 60)::text, 2, '0') || ':' || lpad(((x->>'start')::int % 60)::text, 2, '0'),
                    'end',   lpad(((x->>'end')::int / 60)::text, 2, '0') || ':' || lpad(((x->>'end')::int % 60)::text, 2, '0'))
                    order by (x->>'start')::int), '[]'::jsonb)
                 from jsonb_array_elements(v_segs) x),
    'location', v_ns->>'location',
    'types', to_jsonb(v_types),
    'note', v_note);
end $$;
revoke execute on function public.ot_partial_cover(uuid) from public, anon, authenticated;

-- ⑤ 印の見張り（立てる・下ろすのは受理の Edge Function・自己受理・overtime_set_shift_adjust_needed だけ）
create or replace function public.enforce_overtime_shift_needed()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_uid   uuid := auth.uid();
  v_ok    boolean := coalesce(current_setting('app.sa_needed_ok', true), '') = '1';
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
begin
  if tg_op = 'UPDATE' and old.shift_adjust_needed is not distinct from new.shift_adjust_needed then return new; end if;
  if tg_op = 'INSERT' and not new.shift_adjust_needed then return new; end if;
  if new.shift_adjust_needed then
    if not (coalesce(new.application_types, '{}') && array['location_change', 'late_start_adj', 'tardiness', 'early_end_adj', 'early_leave'])
       or coalesce(new.application_types, '{}') && array['chosei_off', 'furikae_off', 'absence']
       or coalesce(new.is_post_hoc, false)
       or new.from_trip_date is not null
       or new.work_date < v_today then
      raise exception 'SHIFT_ADJUST_NEEDED_NG|この申請では、シフト調整を選べません（遅出・早退・勤務地変更を含む、今日以降の事前申請だけです）'
        using errcode = 'check_violation';
    end if;
  end if;
  -- 画面から直接（ログインした人）：自分で受理する申請（申請先＝本人・事前申請の受理）で、シフト調整の権限がある人だけ
  if v_uid is not null and not v_ok then
    if not (new.reviewer_id = v_uid and new.applicant_id = v_uid and new.status = 'request_confirmed'
            and (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin'
                 or public.user_has_feature_permission(v_uid, 'leave_shift_adjust'))) then
      raise exception 'SHIFT_ADJUST_NEEDED_NG|シフト調整の「必要」は、受理の画面か、受理済みの申請の欄から選んでください'
        using errcode = 'check_violation';
    end if;
  end if;
  if new.shift_adjust_needed then
    new.shift_adjusted_by := coalesce(v_uid, new.shift_adjusted_by);
    new.shift_adjusted_at := now();
  end if;
  return new;
end $$;
revoke execute on function public.enforce_overtime_shift_needed() from public, anon, authenticated;
drop trigger if exists trg_overtime_shift_needed on public.overtime_reports;
create trigger trg_overtime_shift_needed
  before insert or update of shift_adjust_needed on public.overtime_reports
  for each row execute function public.enforce_overtime_shift_needed();

-- ⑥ 相談の作り直しを呼ぶトリガー（遅出・早退・勤務地変更）。中身は終日と同じ trg_shift_adjust_from_overtime を使う
drop trigger if exists trg_zz_shift_adjust_pt_ins on public.overtime_reports;
create trigger trg_zz_shift_adjust_pt_ins
  after insert on public.overtime_reports
  for each row when (new.shift_adjust_needed)
  execute function public.trg_shift_adjust_from_overtime();
drop trigger if exists trg_zz_shift_adjust_pt_upd on public.overtime_reports;
create trigger trg_zz_shift_adjust_pt_upd
  after update on public.overtime_reports
  for each row when ((old.shift_adjust_needed or new.shift_adjust_needed)
    and (old.status is distinct from new.status
         or old.work_date is distinct from new.work_date
         or old.applicant_id is distinct from new.applicant_id
         or old.application_types is distinct from new.application_types
         or old.entry_type is distinct from new.entry_type
         or old.shift_adjust_needed is distinct from new.shift_adjust_needed
         or old.request_confirmed_at is distinct from new.request_confirmed_at
         or old.normal_shift is distinct from new.normal_shift
         or old.location is distinct from new.location))
  execute function public.trg_shift_adjust_from_overtime();
drop trigger if exists trg_zz_shift_adjust_pt_del on public.overtime_reports;
create trigger trg_zz_shift_adjust_pt_del
  after delete on public.overtime_reports
  for each row when (old.shift_adjust_needed)
  execute function public.trg_shift_adjust_from_overtime();

-- 予定の時間帯は申請の行のあとから別の表に入る（消す→入れ直す）。予定が変わったら作り直す
create or replace function public.trg_shift_adjust_from_ot_segments()
returns trigger
language plpgsql security definer set search_path to 'public'
as $$
declare
  v_rid  uuid := coalesce(new.report_id, old.report_id);
  v_user uuid;
  v_date date;
  v_need boolean;
begin
  if coalesce(new.phase, old.phase) <> 'planned' then return null; end if;
  begin
    select applicant_id, work_date, shift_adjust_needed into v_user, v_date, v_need
      from public.overtime_reports where id = v_rid;
    if v_user is not null and v_need then
      perform public.shift_adjust_recompute(v_user, v_date);
    end if;
  exception when others then
    raise warning '[shift_adjust] 残業の時間帯からの作業場の更新に失敗しました: %', sqlerrm;
  end;
  return null;
end $$;
revoke execute on function public.trg_shift_adjust_from_ot_segments() from public, anon, authenticated;
drop trigger if exists trg_zz_shift_adjust_ot_segments on public.overtime_report_segments;
create trigger trg_zz_shift_adjust_ot_segments
  after insert or update or delete on public.overtime_report_segments
  for each row execute function public.trg_shift_adjust_from_ot_segments();

-- ⑦ 受理済みの申請で［必要に変える］［調整不要に変える］（シフト調整の権限がある人・いない時間が始まる前まで）
create or replace function public.overtime_set_shift_adjust_needed(p_report_id uuid, p_needed boolean)
returns table(ok boolean, reason text)
language plpgsql security definer set search_path to 'public'
as $$
declare
  r        public.overtime_reports%rowtype;
  v_uid    uuid := auth.uid();
  v_slot   public.shift_adjust_slots%rowtype;
  v_cover  jsonb;
  v_first  text;
  v_today  date := (now() at time zone 'Asia/Tokyo')::date;
  v_nowmin int := extract(hour from (now() at time zone 'Asia/Tokyo'))::int * 60 + extract(minute from (now() at time zone 'Asia/Tokyo'))::int;
begin
  if v_uid is null then return query select false, 'ログインが必要です'::text; return; end if;
  if not (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin'
          or public.user_has_feature_permission(v_uid, 'leave_shift_adjust')) then
    return query select false, 'シフト調整の権限がある方だけが変えられます'::text; return;
  end if;
  select * into r from public.overtime_reports where id = p_report_id;
  if r.id is null then return query select false, '申請が見つかりません'::text; return; end if;
  if r.applicant_id = v_uid and not coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin' and r.reviewer_id <> v_uid then
    return query select false, 'ご自身の申請は、受理する方が変えます'::text; return;
  end if;
  if r.request_confirmed_at is null or r.status in ('cancelled', 'rejected') then
    return query select false, '受理済みの申請だけ変えられます'::text; return;
  end if;
  if not (coalesce(r.application_types, '{}') && array['location_change', 'late_start_adj', 'tardiness', 'early_end_adj', 'early_leave'])
     or coalesce(r.application_types, '{}') && array['chosei_off', 'furikae_off', 'absence']
     or coalesce(r.is_post_hoc, false) or r.from_trip_date is not null then
    return query select false, 'この申請では、シフト調整を選べません'::text; return;
  end if;
  -- いない時間が始まる前まで
  v_cover := public.ot_partial_cover(r.id);
  v_first := v_cover->'segments'->0->>'start';
  if r.work_date < v_today
     or (r.work_date = v_today and v_first is not null
         and (split_part(v_first, ':', 1)::int * 60 + split_part(v_first, ':', 2)::int) <= v_nowmin) then
    return query select false, 'いない時間が始まったあとは変えられません'::text; return;
  end if;

  select * into v_slot from public.shift_adjust_slots
   where target_user_id = r.applicant_id and target_date = r.work_date;

  if p_needed then
    if not r.shift_adjust_needed then
      perform set_config('app.sa_needed_ok', '1', true);
      update public.overtime_reports set shift_adjust_needed = true where id = r.id;
      perform set_config('app.sa_needed_ok', '', true);
    end if;
    -- 前に［調整不要に変える］で閉じた相談なら、未調整に戻す
    update public.shift_adjust_slots s
       set status = 'pending', not_needed = false, decided_by = null, decided_at = null, updated_at = now()
     where s.target_user_id = r.applicant_id and s.target_date = r.work_date
       and s.cause = 'ot_partial' and s.status = 'no_change'
       and not exists (select 1 from public.shift_adjust_assignments a where a.slot_id = s.id);
  else
    if v_slot.id is not null and v_slot.cause = 'ot_partial' then
      if v_slot.status = 'decided' then
        return query select false, '代わりが決まっています。シフト調整のタブで変えてください'::text; return;
      end if;
      update public.shift_adjust_slots
         set status = 'no_change', not_needed = true, decided_by = v_uid, decided_at = now(), updated_at = now()
       where id = v_slot.id and status in ('pending', 'working', 'cause_cancelled');
    elsif r.shift_adjust_needed then
      perform set_config('app.sa_needed_ok', '1', true);
      update public.overtime_reports set shift_adjust_needed = false where id = r.id;
      perform set_config('app.sa_needed_ok', '', true);
    end if;
  end if;
  return query select true, null::text;
end $$;
revoke execute on function public.overtime_set_shift_adjust_needed(uuid, boolean) from public, anon;
grant execute on function public.overtime_set_shift_adjust_needed(uuid, boolean) to authenticated;

-- ④ 相談を作り直す関数に、遅出・早退・勤務地変更の分かれ道
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
     and o.status in ('confirmed', 'request_confirmed')
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

-- 毎朝のまとめの文：「休み」→「相談」（遅出・早退・勤務地変更も入るため）
CREATE OR REPLACE FUNCTION public.shift_adjust_send_digest()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_st       shift_adjust_settings%rowtype;
  v_now      timestamp := now() at time zone 'Asia/Tokyo';
  v_today    date;
  v_min      int;
  v_start    int;
  v_ref      text;
  v_site_on  boolean;
  v_site_rcp text;
  v_rcp      jsonb := '{}'::jsonb;
  v_statuses text[];
  v_sent     int := 0;
  v_deleted  int := 0;
  r          record;
begin
  v_today := v_now::date;
  v_min   := extract(hour from v_now)::int * 60 + extract(minute from v_now)::int;
  v_ref   := 'shift_adjust_digest:' || to_char(v_today, 'YYYY-MM-DD');

  select * into v_st from shift_adjust_settings s where s.id = 1;
  if not found then
    return jsonb_build_object('ok', false, 'skipped', 'no settings');
  end if;
  if not v_st.digest_enabled then
    return jsonb_build_object('ok', true, 'skipped', 'disabled');
  end if;

  v_start := extract(hour from v_st.digest_time)::int * 60 + extract(minute from v_st.digest_time)::int;
  if v_min < v_start or v_min >= v_start + v_st.digest_window_minutes then
    return jsonb_build_object('ok', true, 'skipped', 'out of window');
  end if;

  -- 前の日のまとめを消す。🚨 残すとベルに昨日の件数が並び、今日の件数と食い違う
  delete from notifications n
   where n.source_type = 'shift_adjust:digest'
     and n.reference_id is distinct from v_ref;
  get diagnostics v_deleted = row_count;

  if not (extract(dow from v_today)::int = any(v_st.digest_weekdays)) then
    return jsonb_build_object('ok', true, 'skipped', 'weekday', 'deleted_old', v_deleted);
  end if;

  -- 宛先（管理画面の通知一覧「シフト調整の毎朝のまとめ」）
  select ns.enabled, ns.recipient into v_site_on, v_site_rcp
    from notification_settings ns
   where ns.event_key = 'shift_adjust:digest' and ns.channel = 'site';
  if v_site_on is false then
    return jsonb_build_object('ok', true, 'skipped', 'site off', 'deleted_old', v_deleted);
  end if;
  begin
    v_rcp := coalesce(nullif(v_site_rcp, '')::jsonb, '{}'::jsonb);
  exception when others then
    v_rcp := '{}'::jsonb;   -- 読めなければ resolve_role_recipients の既定で送る（権限で絞られる）
  end;

  v_statuses := case when v_st.digest_include_working then array['pending', 'working'] else array['pending'] end;

  for r in
    with s as (
      select sl.id, sl.target_user_id, sl.target_date, sl.status, coalesce(p.name, '') as name
        from shift_adjust_slots sl
        join profiles p on p.id = sl.target_user_id
       where sl.status = any(v_statuses)
         and sl.purged_at is null
         and sl.target_date between v_today and v_today + v_st.digest_days
         and p.is_active
    ),
    x as (
      -- 🚨 resolve_role_recipients は休んだ本人を必ず外す（p.id <> p_applicant）＝本人には届かない
      -- 🚨 さらに「シフト調整を見る」権限で絞る。押しても調整の場を開けない人には送らない
      select rid as user_id, s.target_date, s.status, s.name
        from s
        cross join lateral public.resolve_role_recipients(s.target_user_id, v_rcp) rid
       where public.user_has_feature_permission(rid, 'shift_adjust_view')
    )
    select x.user_id,
           count(*) as cnt,
           array_agg(
             to_char(x.target_date, 'FMMM/FMDD') || ' ' || x.name ||
             case when x.status = 'working' then '（調整中）' else '（未調整）' end
             order by x.target_date, x.name) as labels
      from x
     where not exists (
             select 1 from notifications n
              where n.user_id = x.user_id
                and n.source_type = 'shift_adjust:digest'
                and n.reference_id = v_ref)
     group by x.user_id
  loop
    insert into notifications (user_id, message, sub_message, source_type, event_key, reference_id)
    values (
      r.user_id,
      '🔁 シフト調整が済んでいない相談が' || r.cnt::text || '件あります（' || v_st.digest_days::text || '日以内）',
      array_to_string(r.labels[1:5], '／') ||
        case when r.cnt > 5 then ' 他' || (r.cnt - 5)::text || '件' else '' end,
      'shift_adjust:digest',
      'shift_adjust:digest',
      v_ref
    );
    v_sent := v_sent + 1;
  end loop;

  return jsonb_build_object('ok', true, 'today', v_today, 'sent', v_sent, 'deleted_old', v_deleted);
end $function$;
