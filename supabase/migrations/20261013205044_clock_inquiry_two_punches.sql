-- 打刻の確認：打刻を2組入れられるようにする（外出・戻りなど・2026-10-13 経理担当の意見・ユーザー確定）
-- ・overtime_clock_inquiry_days に clock_in2／clock_out2（2組目・任意）
-- ・send_overtime_clock_inquiry は本番の実定義から起こし、clock_in2／clock_out2 を受け取って入れるだけ足した（渡されなければ空＝今までどおり）
-- ・resolve_clock_inquiry_cancel は本番の実定義から起こし、打刻ズレの退勤に「最後の退勤（2組目があればそちら）」を入れるようにした
begin;

alter table public.overtime_clock_inquiry_days add column if not exists clock_in2 time;
alter table public.overtime_clock_inquiry_days add column if not exists clock_out2 time;
comment on column public.overtime_clock_inquiry_days.clock_in2 is '2組目の出勤打刻（外出から戻ったときなど・任意）';
comment on column public.overtime_clock_inquiry_days.clock_out2 is '2組目の退勤打刻（任意）。最後の退勤は coalesce(clock_out2, clock_out)';

CREATE OR REPLACE FUNCTION public.send_overtime_clock_inquiry(p_user_id uuid, p_days jsonb, p_message text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id        uuid;
  v_today     date := (now() at time zone 'Asia/Tokyo')::date;
  e           jsonb;
  v_date      date;
  v_pps       date;
  v_deadline  date;
  v_dates     date[] := '{}';
  v_label     text;
  v_site_on   boolean;
  v_side      text;
begin
  if not coalesce(is_admin(), false) then
    raise exception '打刻の確認を送れるのは経理（管理者）だけです';
  end if;
  if p_user_id is null then
    raise exception '対象者を選んでください';
  end if;
  if jsonb_typeof(p_days) <> 'array' or jsonb_array_length(p_days) = 0 then
    raise exception '対象の日を1日以上選んでください';
  end if;

  -- 同じ日に未回答の確認が既にあるなら送らない。
  -- 二度聞きになるうえ、両方に「打刻が遅れただけ」と答えると
  -- 2件目の記録作成が uq_overtime_manual_per_day で 23505 になる。
  if exists (
    select 1
      from public.overtime_clock_inquiry_days d
      join public.overtime_clock_inquiries i on i.id = d.inquiry_id
     where i.user_id = p_user_id
       and i.status  = 'open'
       and d.work_date in (
         select (x ->> 'work_date')::date from jsonb_array_elements(p_days) x
       )
  ) then
    raise exception 'この日はすでに確認を送っています（未回答）' using errcode = 'P0001';
  end if;

  insert into public.overtime_clock_inquiries (user_id, sender_id, message)
  values (p_user_id, auth.uid(), nullif(btrim(coalesce(p_message, '')), ''))
  returning id into v_id;

  for e in select * from jsonb_array_elements(p_days) loop
    v_date := (e ->> 'work_date')::date;
    if v_date is null then
      raise exception '日付が正しくありません';
    end if;
    -- 何について聞くか（2026-10-13）：after＝退勤のあと（今まで）／before＝出勤前／both＝両方。渡されなければ after
    v_side := coalesce(nullif(e ->> 'ask_side', ''), 'after');
    if v_side not in ('after', 'before', 'both') then
      raise exception '聞くことが正しくありません（%）', v_side;
    end if;

    insert into public.overtime_clock_inquiry_days
      (inquiry_id, work_date, shift_start, shift_end, shift_start2, shift_end2, clock_in, clock_out, clock_in2, clock_out2, ask_side)
    values (
      v_id, v_date,
      nullif(e ->> 'shift_start', '')::time,
      nullif(e ->> 'shift_end',   '')::time,
      nullif(e ->> 'shift_start2','')::time,
      nullif(e ->> 'shift_end2',  '')::time,
      nullif(e ->> 'clock_in',    '')::time,
      nullif(e ->> 'clock_out',   '')::time,
      nullif(e ->> 'clock_in2',   '')::time,
      nullif(e ->> 'clock_out2',  '')::time,
      v_side
    )
    on conflict (inquiry_id, work_date) do nothing;

    if not (v_date = any(v_dates)) then
      v_dates := v_dates || v_date;   -- 同じ日を2回渡されても件数ラベルを狂わせない
    end if;

    -- 締め後でも本人が報告できるよう、その日だけ許可を付ける。
    -- ただし給与データ確定日を過ぎた期には付けない（支給済みの期に新規行が入る道を作らない）
    v_pps      := public.calc_pay_period_start(v_date);
    v_deadline := public.overtime_grant_deadline(v_pps);
    if v_deadline is null or v_today <= v_deadline then
      insert into public.overtime_submission_grants (user_id, work_date, granted_by, note, source)
      values (p_user_id, v_date, auth.uid(),
              '打刻の確認（' || to_char(v_date, 'MM/DD') || '）', 'clock_inquiry')
      -- 生きている許可がある日は触らない。
      -- 経理が手で付けた許可を clock_inquiry に乗っ取ると、
      -- 回答後に link_clock_inquiry_result が勝手に閉じてしまう。
      -- 取消済みの行だけ、打刻の確認由来として引き取る（回答後に閉じられる状態にする）。
      on conflict (user_id, work_date) do update
        set revoked_at = null,
            revoked_by = null,
            granted_by = excluded.granted_by,
            note       = excluded.note,
            source     = excluded.source
        where overtime_submission_grants.revoked_at is not null;
    end if;
  end loop;

  -- 本人への通知（管理者が送るので RLS は通るが、部分成功を避けるためここで作る）
  -- ⚠️ 本文に「お知らせ」「リマインド」「メッセージが届き」「への対応がまだ完了していません」を入れない
  --    （App.tsx の連絡板判定・催促判定が先に効いてタップで /board に飛ぶ）
  select to_char(min(t.d), 'MM/DD') ||
         case when count(*) > 1 then ' 他' || (count(*) - 1) || '日' else '' end
    into v_label
    from unnest(v_dates) as t(d);

  -- 管理画面のON/OFFに従う（行が無ければ送る）。設定はあるのに効かない「死に設定」を作らない
  select enabled into v_site_on from public.notification_settings
   where event_key = 'overtime:clock_inquiry' and channel = 'site';

  if coalesce(v_site_on, true) then
    insert into public.notifications
      (user_id, message, sub_message, source_type, reference_id, event_key)
    values (
      p_user_id,
      '経理から勤務時間の確認です',
      v_label || '　タップして回答してください',
      'overtime:clock_inquiry', v_id::text, 'overtime:clock_inquiry'
    );
  end if;

  return v_id;
end; $function$;

CREATE OR REPLACE FUNCTION public.resolve_clock_inquiry_cancel(p_day_id uuid, p_note text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_d    overtime_clock_inquiry_days%rowtype;
  v_r    overtime_reports%rowtype;
  v_ns   jsonb;
  v_snap jsonb;
  v_new  uuid;
  v_st   int; v_en int;
  v_no   int := 0;
begin
  if not coalesce(is_admin(), false) then
    raise exception 'permission denied: admin only' using errcode = '42501';
  end if;

  select * into v_d from overtime_clock_inquiry_days where id = p_day_id for update;
  if not found then
    raise exception 'CLOCK_INQ_NOT_FOUND' using errcode = 'P0002';
  end if;
  if v_d.answer <> 'time_differs' then
    raise exception 'CLOCK_INQ_BAD_ANSWER: 本人が「時刻が違います」と答えた日だけ取り消せます' using errcode = '22023';
  end if;
  if v_d.resolved_kind is not null then
    raise exception 'CLOCK_INQ_ALREADY_RESOLVED: この日はすでに対応済みです' using errcode = '22023';
  end if;

  select * into v_r from overtime_reports
   where id = coalesce(v_d.existing_report_id, v_d.result_report_id) for update;
  if not found then
    raise exception 'CLOCK_INQ_NO_REPORT: この日の申請が見つかりません' using errcode = 'P0002';
  end if;
  if v_r.entry_type <> 'manual' or v_r.status not in ('reported', 'confirmed') then
    raise exception 'CLOCK_INQ_REPORT_STATE: この申請の状態（%）では取り消せません', v_r.status using errcode = '22023';
  end if;
  if v_r.work_date <> v_d.work_date or v_r.furikae_origin_date is not null then
    raise exception 'CLOCK_INQ_REPORT_STATE: 振替の申請は取り消せません。［直す］を使ってください' using errcode = '22023';
  end if;
  if not (v_r.application_types <@ array['overtime', 'early_start']::text[]) then
    raise exception 'CLOCK_INQ_REPORT_TYPES: 残業・早出以外の種別が入っている申請は、定時にできません。［直す］を使ってください' using errcode = '22023';
  end if;
  v_ns := v_r.normal_shift;
  if v_ns is null or coalesce(v_ns->>'start_time', '') = '' then
    raise exception 'CLOCK_INQ_NO_SHIFT: この申請にシフトが入っていないため、定時の記録を作れません' using errcode = '22023';
  end if;

  -- ① 申請を取り消す（履歴に前の中身を残す）
  v_snap := to_jsonb(v_r);
  update overtime_reports set status = 'cancelled' where id = v_r.id;
  insert into overtime_report_history (report_id, changed_by, change_kind, change_summary, change_reason, snapshot)
  values (v_r.id, auth.uid(), 'cancelled', '打刻の確認のお答えにより取消（定時の記録にした）',
          nullif(btrim(coalesce(p_note, '')), ''), v_snap);

  -- ② 打刻ズレ（定時・確認済み）を作る。本人の画面で作るものと同じ形（ClockInquiryResponse）
  insert into overtime_reports (
    applicant_id, submitted_by, entry_type, work_date, pay_period_start, is_post_hoc, status,
    normal_shift, break_minutes, break_manual, labor_minutes, diff_minutes, legal_warning,
    reason, location, application_types, clock_in_reported, clock_out_reported,
    reviewer_id, confirmed_by, confirmed_at, accounting_checked_at, accounting_checked_by
  ) values (
    v_r.applicant_id, auth.uid(), 'manual', v_r.work_date, calc_pay_period_start(v_r.work_date), true, 'confirmed',
    v_ns, nullif(v_ns->>'break_minutes', '')::int, false, nullif(v_ns->>'labor_minutes', '')::int, 0, false,
    '残業ではありません（打刻の確認のお答えにより、経理が定時の記録にしました）',
    coalesce(v_r.location, ''), array['clock_only']::text[], v_d.clock_in, coalesce(v_d.clock_out2, v_d.clock_out),
    auth.uid(), auth.uid(), now(), now(), auth.uid()
  ) returning id into v_new;

  -- シフトの時間帯（1本目・2本目）。終わりが始まり以前なら翌日
  for v_st, v_en in
    select (extract(hour from s::time) * 60 + extract(minute from s::time))::int,
           (extract(hour from e::time) * 60 + extract(minute from e::time))::int
      from (values (v_ns->>'start_time', v_ns->>'end_time', 1), (v_ns->>'start_time2', v_ns->>'end_time2', 2)) x(s, e, o)
     where coalesce(s, '') <> '' and coalesce(e, '') <> ''
     order by o
  loop
    v_no := v_no + 1;
    insert into overtime_report_segments (report_id, phase, seg_no, start_min, end_min)
    values (v_new, 'actual', v_no, v_st, case when v_en <= v_st then v_en + 1440 else v_en end);
  end loop;

  -- ③ 確認と結び付けて「取り消しました」にする
  update overtime_clock_inquiry_days
     set result_report_id = v_new, resolved_kind = 'cancelled', resolved_at = now(), resolved_by = auth.uid(),
         resolved_note = nullif(btrim(coalesce(p_note, '')), '')
   where id = p_day_id;

  return v_new;
end;
$function$;

revoke execute on function public.send_overtime_clock_inquiry(uuid, jsonb, text) from public;
revoke execute on function public.send_overtime_clock_inquiry(uuid, jsonb, text) from anon;
grant execute on function public.send_overtime_clock_inquiry(uuid, jsonb, text) to authenticated;
revoke execute on function public.resolve_clock_inquiry_cancel(uuid, text) from public;
revoke execute on function public.resolve_clock_inquiry_cancel(uuid, text) from anon;
grant execute on function public.resolve_clock_inquiry_cancel(uuid, text) to authenticated;

commit;
