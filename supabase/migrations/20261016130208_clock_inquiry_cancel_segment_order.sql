-- 打刻の確認：経理の［取り消して定時にする］で作る記録の時間帯を、時刻の早い順に並べる（2026-10-16）
-- 🚨 本番の実定義（pg_get_functiondef）から起こした。変えたのは order by の1行だけ

begin;

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
     -- 🚨 時刻の早い順（2026-10-16）。1本目→2本目の順だと、2本目のほうが早い人（朝 6:30〜7:15 ＋ 9:30〜17:30）で逆に並んだ
     order by (extract(hour from s::time) * 60 + extract(minute from s::time))
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

revoke execute on function public.resolve_clock_inquiry_cancel(uuid, text) from public;
revoke execute on function public.resolve_clock_inquiry_cancel(uuid, text) from anon;
grant execute on function public.resolve_clock_inquiry_cancel(uuid, text) to authenticated;

commit;
