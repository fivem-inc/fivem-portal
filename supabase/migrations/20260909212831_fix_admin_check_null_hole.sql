-- 🚨🚨 管理者チェックが素通りしていた6本を直す（2026-09-09・実測で発見）
--
-- 【何が起きていたか】
--   if (auth.jwt() -> 'app_metadata' ->> 'role') <> 'admin' then raise ... end if;
--       ↑ app_metadata を持たない人（管理者以外のほぼ全員）では
--         この比較が false ではなく **NULL** になり、if NULL は成立せず**素通りする**。
--
--   🚨 実測で確認した：実在する一般スタッフになりすまして admin_edit_leave_request を呼ぶと、
--      **他人の休暇申請の種別を書き換えられた**（検証は rollback 済み・本番データは無傷）。
--      6本とも anon（ログインしていない人）からも呼べる状態だった。
--      このリポジトリは Public で anon キーは client/.env.production に入っている＝誰でも入手できる。
--
--   🚨 最初の検証では 23502（not-null違反）・23503（外部キー違反）で「弾かれた」ように見えた。
--      しかしこれは権限で止まったのではなく、**たまたま制約に引っかかっただけ**。
--      正しい値を渡したら通った。**「弾かれた」だけを見て安全と判断しないこと。**
--
-- 【直し方】
--   ・判定を is_admin() に統一する。is_admin() は中で coalesce しており null を返さない。
--     さらに二重に coalesce で包む（この関数が将来変わっても素通りしないように）。
--   ・「本人 or 管理者」の判定は <> ではなく is distinct from を使う
--     （どちらかが null でも必ず true/false になる）。
--   ・anon の実行権限を外す（public と anon の両方から外し、authenticated へ付け直す）。
--
-- 🚨 この6本の定義は、リポジトリのファイルではなく **本番の pg_get_functiondef から起こした**。
--    変更したのは権限チェックの行だけで、処理の中身は1文字も変えていない。
--
-- 【CLAUDE.md に書かれていた落とし穴】
--   「RLS/RPCの管理者判定は必ず (auth.jwt()->'app_metadata'->>'role')='admin'
--     （'role' の直参照は常に false。過去に2回踏んでいる）」
--   今日これで3回目。**= で比べるか、is_admin() を使う**こと。

CREATE OR REPLACE FUNCTION public.admin_edit_leave_request(p_id uuid, p_leave_type text, p_leave_type_other text, p_leave_dates text, p_leave_locations text, p_purpose text, p_reason text, p_start_date date, p_end_date date, p_changes jsonb, p_change_summary text, p_change_reason text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_snapshot jsonb;
begin
  if not coalesce(is_admin(), false) then
    raise exception 'permission denied: admin only' using errcode = '42501';
  end if;

  select to_jsonb(lr.*) into v_snapshot from leave_requests lr where lr.id = p_id;
  if v_snapshot is null then
    raise exception 'leave_request not found: %', p_id using errcode = 'P0002';
  end if;

  update leave_requests set
    leave_type       = p_leave_type,
    leave_type_other = p_leave_type_other,
    leave_dates      = p_leave_dates,
    leave_locations  = p_leave_locations,
    purpose          = p_purpose,
    reason           = p_reason,
    start_date       = p_start_date,
    end_date         = p_end_date,
    modified_by      = auth.uid(),
    modified_at      = now()
  where id = p_id;

  insert into leave_request_history
    (leave_request_id, change_kind, change_summary, change_reason, changes, snapshot, changed_by)
  values
    (p_id, 'admin_edit', p_change_summary, p_change_reason, p_changes, v_snapshot, auth.uid());
end;
$function$;


-- ===================================

CREATE OR REPLACE FUNCTION public.admin_edit_overtime_report(p_id uuid, p_work_date date, p_break_minutes integer, p_break_manual boolean, p_labor_minutes integer, p_diff_minutes integer, p_legal_warning boolean, p_reason text, p_location text, p_phase text, p_segments jsonb, p_changes jsonb, p_change_summary text, p_change_reason text, p_application_types text[] DEFAULT NULL::text[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_snapshot jsonb;
  v_entry_type text;
  v_seg jsonb;
begin
  if not coalesce(is_admin(), false) then
    raise exception 'permission denied: admin only' using errcode = '42501';
  end if;

  select to_jsonb(r.*), r.entry_type into v_snapshot, v_entry_type
  from overtime_reports r where r.id = p_id;
  if v_snapshot is null then
    raise exception 'overtime_report not found: %', p_id using errcode = 'P0002';
  end if;
  -- 自動計上行（調整休由来）はトリガー管理のため直接修正を禁止
  if v_entry_type <> 'manual' then
    raise exception 'leave_auto rows cannot be edited directly' using errcode = 'P0001';
  end if;
  if p_phase not in ('planned','actual') then
    raise exception 'invalid phase: %', p_phase using errcode = '22023';
  end if;

  update overtime_reports set
    work_date      = p_work_date,
    pay_period_start = calc_pay_period_start(p_work_date),
    break_minutes  = p_break_minutes,
    break_manual   = p_break_manual,
    labor_minutes  = p_labor_minutes,
    diff_minutes   = p_diff_minutes,
    legal_warning  = p_legal_warning,
    reason         = p_reason,
    location       = p_location,
    application_types = coalesce(p_application_types, application_types),
    updated_at     = now()
  where id = p_id;

  -- 指定phaseの時間帯を全入れ替え
  delete from overtime_report_segments where report_id = p_id and phase = p_phase;
  for v_seg in select * from jsonb_array_elements(coalesce(p_segments, '[]'::jsonb))
  loop
    insert into overtime_report_segments (report_id, phase, seg_no, start_min, end_min)
    values (
      p_id, p_phase,
      (v_seg->>'seg_no')::int,
      (v_seg->>'start_min')::int,
      (v_seg->>'end_min')::int
    );
  end loop;

  insert into overtime_report_history
    (report_id, changed_by, change_kind, change_summary, change_reason, changes, snapshot)
  values
    (p_id, auth.uid(), 'admin_edit', p_change_summary, p_change_reason, p_changes, v_snapshot);
end;
$function$;


-- ===================================

CREATE OR REPLACE FUNCTION public.admin_edit_shift_report(p_id uuid, p_application_types text[], p_work_date date, p_actual_location text, p_actual_start time without time zone, p_actual_end time without time zone, p_actual_outing_start time without time zone, p_actual_outing_end time without time zone, p_break_minutes integer, p_labor_minutes integer, p_reason text, p_changes jsonb, p_change_summary text, p_change_reason text, p_actual_segments jsonb DEFAULT NULL::jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_snapshot jsonb;
begin
  if not coalesce(is_admin(), false) then
    raise exception 'permission denied: admin only' using errcode = '42501';
  end if;

  -- 時間帯は最大3つ（本人の報告画面・DBの持ち方と同じ制限）
  if p_actual_segments is not null and jsonb_typeof(p_actual_segments) <> 'array' then
    raise exception 'p_actual_segments must be a jsonb array' using errcode = '22023';
  end if;
  if p_actual_segments is not null and jsonb_array_length(p_actual_segments) > 3 then
    raise exception 'p_actual_segments: too many segments (max 3)' using errcode = '22023';
  end if;

  select to_jsonb(sr.*) into v_snapshot from shift_reports sr where sr.id = p_id;
  if v_snapshot is null then
    raise exception 'shift_report not found: %', p_id using errcode = 'P0002';
  end if;

  update shift_reports set
    application_types    = p_application_types,
    application_type     = coalesce(p_application_types[1], application_type),
    work_date            = p_work_date,
    actual_location      = p_actual_location,
    actual_start         = p_actual_start,
    actual_end           = p_actual_end,
    actual_outing_start  = p_actual_outing_start,
    actual_outing_end    = p_actual_outing_end,
    actual_segments      = p_actual_segments,
    break_minutes        = p_break_minutes,
    labor_minutes        = p_labor_minutes,
    reason               = p_reason,
    updated_at           = now()
  where id = p_id;

  insert into shift_report_history
    (report_id, changed_by, change_kind, change_summary, change_reason, changes, snapshot)
  values
    (p_id, auth.uid(), 'admin_edit', p_change_summary, p_change_reason, p_changes, v_snapshot);
end;
$function$;


-- ===================================

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

    insert into public.overtime_clock_inquiry_days
      (inquiry_id, work_date, shift_start, shift_end, shift_start2, shift_end2, clock_in, clock_out)
    values (
      v_id, v_date,
      nullif(e ->> 'shift_start', '')::time,
      nullif(e ->> 'shift_end',   '')::time,
      nullif(e ->> 'shift_start2','')::time,
      nullif(e ->> 'shift_end2',  '')::time,
      nullif(e ->> 'clock_in',    '')::time,
      nullif(e ->> 'clock_out',   '')::time
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


-- ===================================

CREATE OR REPLACE FUNCTION public.set_overtime_show_on_calendar(p_id uuid, p_value boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_owner uuid;
begin
  select applicant_id into v_owner from overtime_reports where id = p_id;

  if v_owner is null then
    raise exception '対象の申請が見つかりません';
  end if;

  if v_owner is distinct from auth.uid()
     and not coalesce(is_admin(), false) then
    raise exception 'この申請を変更する権限がありません';
  end if;

  update overtime_reports
     set show_on_calendar = p_value
   where id = p_id;
end;
$function$;


-- ===================================

CREATE OR REPLACE FUNCTION public.withdraw_overtime_clock_inquiry(p_inquiry_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user    uuid;
  v_updated int;
begin
  if not coalesce(is_admin(), false) then
    raise exception '取り下げできるのは経理（管理者）だけです';
  end if;

  update public.overtime_clock_inquiries
     set status = 'withdrawn'
   where id = p_inquiry_id and status = 'open'
  returning user_id into v_user;
  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    return false;   -- 既に回答済み／取り下げ済み
  end if;

  update public.overtime_submission_grants g
     set revoked_at = now(), revoked_by = auth.uid()
   where g.user_id = v_user
     and g.source = 'clock_inquiry'
     and g.revoked_at is null
     and g.work_date in (
       select d.work_date from public.overtime_clock_inquiry_days d
        where d.inquiry_id = p_inquiry_id
     );

  return true;
end; $function$;


-- 🚨 anon（ログインしていない人）の実行権限を外す。
--    anon だけ名指ししても外れない（anon は PUBLIC の一員）。public と両方から外し、
--    ログイン済みの人には付け直す（2026-09-09 に実測して分かった）。
revoke execute on function public.admin_edit_leave_request(uuid, text, text, text, text, text, text, date, date, jsonb, text, text) from public, anon;
grant  execute on function public.admin_edit_leave_request(uuid, text, text, text, text, text, text, date, date, jsonb, text, text) to authenticated;

revoke execute on function public.admin_edit_overtime_report(uuid, date, integer, boolean, integer, integer, boolean, text, text, text, jsonb, jsonb, text, text, text[]) from public, anon;
grant  execute on function public.admin_edit_overtime_report(uuid, date, integer, boolean, integer, integer, boolean, text, text, text, jsonb, jsonb, text, text, text[]) to authenticated;

revoke execute on function public.admin_edit_shift_report(uuid, text[], date, text, time, time, time, time, integer, integer, text, jsonb, text, text, jsonb) from public, anon;
grant  execute on function public.admin_edit_shift_report(uuid, text[], date, text, time, time, time, time, integer, integer, text, jsonb, text, text, jsonb) to authenticated;

revoke execute on function public.send_overtime_clock_inquiry(uuid, jsonb, text) from public, anon;
grant  execute on function public.send_overtime_clock_inquiry(uuid, jsonb, text) to authenticated;

revoke execute on function public.set_overtime_show_on_calendar(uuid, boolean) from public, anon;
grant  execute on function public.set_overtime_show_on_calendar(uuid, boolean) to authenticated;

revoke execute on function public.withdraw_overtime_clock_inquiry(uuid) from public, anon;
grant  execute on function public.withdraw_overtime_clock_inquiry(uuid) to authenticated;
