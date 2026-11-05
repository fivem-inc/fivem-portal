-- 勤務変更（パートの方）の事前申請 段1：DB（2026-11-06・計画 docs/計画-勤務変更-事前申請.md・ユーザー確定）
-- 流れ：requested（事前申請・受理待ち）→ request_confirmed（事前申請 受理済み＝丸「受」）→ その日以降にご本人が
--   ［申請どおりでした（確定）］＝ shift_report_finish_advance(id,'as_planned') → confirmed（受理なし）
--   ［時間が違いました］＝ 中身を直して pending → 上長が確認（今までの報告と同じ）
--   ［申請した変更はありませんでした］＝ shift_report_finish_advance(id,'no_change') → cancelled
-- ・申請の中身は今までと同じ欄（actual_* など）に入れる。受理の瞬間にトリガーが planned（中身の写し）を残す（報告で書き換えても申請が分かる）
-- ・advance＝事前申請から始まった行（入れるときにトリガーが決める）。returned で request_confirmed_at が空なら「事前申請の差し戻し」
-- ・最初は 社長・管理者だけ（feature_key shift_report_advance）。欠勤・打刻忘れは事前申請にしない（欠勤は今までどおり前もって「報告」）
-- ・上長が勤怠カレンダー（attendance_exceptions）に入れた日は事前申請を止める
-- 🚨 1人1日1行（一意 applicant_id, work_date）のまま。取り消すとその日はもう報告できない（前からの制限・管理者へ）
-- 一緒に直した今ある不具合：退職・休職の付け替え／受理待ちの数が status='pending' だけで、出し直し（resubmitted）が漏れていた

-- 1) 状態と列
alter table public.shift_reports drop constraint shift_reports_status_check;
alter table public.shift_reports add constraint shift_reports_status_check
  check (status = any (array['pending','resubmitted','confirmed','cancelled','returned','requested','request_confirmed']));
alter table public.shift_reports
  add column if not exists advance boolean not null default false,
  add column if not exists request_confirmed_at timestamptz,
  add column if not exists request_confirmed_by uuid references public.profiles(id) on delete set null,
  add column if not exists planned jsonb;
comment on column public.shift_reports.advance is '事前申請から始まった行（トリガーが決める・あとから変えられない）';
comment on column public.shift_reports.planned is '事前申請が受理された瞬間の中身の写し（トリガーが書く）';

-- 2) 権限（最初は社長・管理者だけ）
insert into public.feature_permissions (role_id, feature_key, enabled)
select r.id, 'shift_report_advance', coalesce(r.acts_as = 'president' or r.is_fixed, false)
  from public.roles r
 where not exists (select 1 from public.feature_permissions f where f.role_id = r.id and f.feature_key = 'shift_report_advance');

-- 3) 予定の終わりの時刻（申請どおりで確定できるのはこの時刻から）
create or replace function public.shift_report_planned_end(r public.shift_reports)
returns timestamptz
language sql
stable
set search_path to 'public'
as $function$
  select (r.work_date + coalesce(
            (select max((e->>'end')::time) from jsonb_array_elements(case when jsonb_typeof(r.actual_segments) = 'array' then r.actual_segments else '[]'::jsonb end) e
              where coalesce(e->>'end', '') <> ''),
            r.actual_end,
            time '23:59')) at time zone 'Asia/Tokyo';
$function$;
revoke execute on function public.shift_report_planned_end(public.shift_reports) from public;
revoke execute on function public.shift_report_planned_end(public.shift_reports) from anon;

-- 4) 見張り（段0 の enforce_shift_report_status に事前申請を足す）
create or replace function public.enforce_shift_report_status()
returns trigger
language plpgsql
security invoker
set search_path to 'public'
as $function$
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_types text[] := coalesce(new.application_types, array[new.application_type]);
  v_self boolean := new.applicant_id = auth.uid();
begin
  -- 事前申請の印・受理の記録・写しは、ここでしか決めない（service_role も含めて、前の値を残してから下で決める）
  if tg_op = 'UPDATE' then
    new.advance := old.advance;
    new.request_confirmed_at := old.request_confirmed_at;
    new.request_confirmed_by := old.request_confirmed_by;
    new.planned := old.planned;
  else
    new.advance := (new.status = 'requested');
    new.request_confirmed_at := null; new.request_confirmed_by := null; new.planned := null;
  end if;

  -- 事前申請の受理：受理の記録と中身の写し（だれが動かしても同じ）
  if tg_op = 'UPDATE' and new.status = 'request_confirmed' and old.status is distinct from 'request_confirmed' then
    new.request_confirmed_at := now();
    new.request_confirmed_by := auth.uid();
    new.planned := jsonb_build_object(
      'application_type', new.application_type, 'application_types', new.application_types,
      'actual_start', new.actual_start, 'actual_end', new.actual_end, 'actual_segments', new.actual_segments,
      'actual_location', new.actual_location, 'break_minutes', new.break_minutes, 'labor_minutes', new.labor_minutes,
      'reason', new.reason);
  end if;
  -- 事前申請に戻したら受理の記録は消す
  if tg_op = 'UPDATE' and new.status = 'requested' and old.status is distinct from 'requested' then
    new.request_confirmed_at := null; new.request_confirmed_by := null; new.planned := null;
  end if;

  if auth.uid() is null then return new; end if;  -- service_role・cron
  if current_setting('app.sr_finish', true) = 'on' then return new; end if;  -- shift_report_finish_advance の中だけ

  if tg_op = 'INSERT' then
    if not v_self and not is_admin() and not is_approver() then
      raise exception 'ほかの方の勤務変更は、受理できる方だけが代わりに報告できます' using errcode = '42501';
    end if;
    if new.status = 'requested' then
      if not has_feature_permission('shift_report_advance') then
        raise exception '事前申請はまだ使えません' using errcode = '42501';
      end if;
      if new.work_date <= v_today then
        raise exception '今日・過ぎた日は「報告」で送ってください' using errcode = '22023';
      end if;
      if v_types && array['absence', 'missed_clock'] then
        raise exception '欠勤・打刻忘れは事前申請ではなく「報告」で送ってください' using errcode = '22023';
      end if;
      if exists (select 1 from attendance_exceptions a where a.user_id = new.applicant_id and a.date = new.work_date) then
        raise exception 'この日は上長が勤務の変更を入力しています。当日になったら報告してください' using errcode = '22023';
      end if;
      return new;
    end if;
    if is_admin() then return new; end if;
    if new.status = 'pending' then return new; end if;
    if new.status = 'confirmed' and not v_self and new.reviewer_id = auth.uid() and is_approver() then
      new.confirmed_by := auth.uid();
      new.confirmed_at := coalesce(new.confirmed_at, now());
      return new;
    end if;
    raise exception '勤務変更の報告は「確認待ち」で送ってください（受理は申請先の方が行います）' using errcode = '42501';
  end if;

  -- ここから UPDATE
  if new.status is not distinct from old.status then
    -- 受理済みの事前申請の中身は、ご本人が書き換えられない（直すときは事前申請に戻す＝受理のやり直し）
    if old.status = 'request_confirmed' and not is_admin()
       and (new.actual_segments, new.actual_start, new.actual_end, new.actual_location, new.application_types, new.application_type, new.work_date)
           is distinct from (old.actual_segments, old.actual_start, old.actual_end, old.actual_location, old.application_types, old.application_type, old.work_date) then
      raise exception '受理された事前申請は、内容を変更すると受理のやり直しになります' using errcode = '42501';
    end if;
    return new;
  end if;

  -- 事前申請の受理
  if new.status = 'request_confirmed' then
    if old.status = 'requested'
       and (is_admin() or (old.reviewer_id = auth.uid() and new.reviewer_id = auth.uid() and not v_self and is_approver())) then
      return new;
    end if;
    raise exception '事前申請の受理は申請先の方が行います' using errcode = '42501';
  end if;

  -- 事前申請に戻す：①事前申請の差し戻しを直して出し直す ②受理のあと、その日の前に内容を変える。先の日だけ・ご本人か管理者
  if new.status = 'requested' then
    if (v_self or is_admin()) and new.work_date > v_today
       and not (v_types && array['absence', 'missed_clock'])
       and (old.status = 'request_confirmed'
            or (old.status = 'returned' and old.advance and old.request_confirmed_at is null)) then
      return new;
    end if;
    raise exception '事前申請に戻せるのは、先の日のご本人の申請だけです' using errcode = '42501';
  end if;

  -- 当日以降の報告（事前申請 → 報告）。受理の前に当日が来ても報告できる
  if new.status = 'pending' and old.status in ('requested', 'request_confirmed') then
    if new.work_date <= v_today and (v_self or is_admin()) then return new; end if;
    raise exception '実績の報告は、その日になってから送ってください' using errcode = '22023';
  end if;

  -- 事前申請の取消：その日が来るまで（あとは［申請した変更はありませんでした］か管理者）
  if new.status = 'cancelled' and old.status in ('requested', 'request_confirmed') then
    if is_admin() or (v_self and old.work_date > v_today) then return new; end if;
    raise exception 'その日が来たため、取り消しはできません（［申請した変更はありませんでした］を使うか、管理者に依頼してください）' using errcode = '42501';
  end if;

  if is_admin() then return new; end if;

  if new.status in ('confirmed', 'returned') then
    if old.reviewer_id = auth.uid()
       and new.reviewer_id = auth.uid()
       and not v_self
       and (old.status in ('pending', 'resubmitted', 'confirmed') or (new.status = 'returned' and old.status = 'requested'))
       and is_approver() then
      if new.status = 'confirmed' then
        new.confirmed_by := auth.uid();
        new.confirmed_at := coalesce(new.confirmed_at, now());
      end if;
      return new;
    end if;
    raise exception '受理・差し戻しは申請先の方が行います' using errcode = '42501';
  end if;
  return new;
end;
$function$;
revoke execute on function public.enforce_shift_report_status() from public;
revoke execute on function public.enforce_shift_report_status() from anon;

-- 5) ご本人の［申請どおりでした（確定）］［申請した変更はありませんでした］
create or replace function public.shift_report_finish_advance(p_id uuid, p_kind text)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r shift_reports%rowtype;
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
begin
  if auth.uid() is null then raise exception 'ログインしてください' using errcode = '42501'; end if;
  select * into r from shift_reports where id = p_id for update;
  if not found or (r.applicant_id <> auth.uid() and not is_admin()) then
    raise exception 'この申請は見つかりません' using errcode = '42501';
  end if;
  if p_kind = 'as_planned' then
    if r.status <> 'request_confirmed' then
      raise exception '受理された事前申請だけ「申請どおり」で確定できます' using errcode = '22023';
    end if;
    if now() < shift_report_planned_end(r) then
      raise exception '申請した勤務が終わってから押してください' using errcode = '22023';
    end if;
    perform set_config('app.sr_finish', 'on', true);
    update shift_reports set status = 'confirmed', confirmed_by = auth.uid(), confirmed_at = now() where id = p_id;
    perform set_config('app.sr_finish', 'off', true);
    return 'confirmed';
  elsif p_kind = 'no_change' then
    if r.status not in ('requested', 'request_confirmed') then
      raise exception 'この申請はもう変えられません' using errcode = '22023';
    end if;
    if r.work_date > v_today then
      raise exception 'その日が来るまでは「この申請を取り消す」を使ってください' using errcode = '22023';
    end if;
    perform set_config('app.sr_finish', 'on', true);
    update shift_reports set status = 'cancelled' where id = p_id;
    perform set_config('app.sr_finish', 'off', true);
    return 'cancelled';
  end if;
  raise exception '種類が違います' using errcode = '22023';
end;
$function$;
revoke execute on function public.shift_report_finish_advance(uuid, text) from public;
revoke execute on function public.shift_report_finish_advance(uuid, text) from anon;
grant execute on function public.shift_report_finish_advance(uuid, text) to authenticated;

-- 6) ご本人の書き換え・取消のポリシーに事前申請を足す（日付と流れは見張りが決める）
alter policy applicant_update_own_pending on public.shift_reports
  using ((applicant_id = auth.uid()) and (status = any (array['pending','resubmitted','returned','requested','request_confirmed'])))
  with check ((applicant_id = auth.uid()) and (status = any (array['pending','resubmitted','requested','request_confirmed'])));
alter policy applicant_cancel on public.shift_reports
  using ((applicant_id = auth.uid()) and (status = any (array['pending','resubmitted','returned','requested','request_confirmed'])))
  with check ((applicant_id = auth.uid()) and (status = 'cancelled'));

-- 7) 受理待ち・付け替え・締め・CSV（本番の実定義から・差し替えは status の所だけ）
CREATE OR REPLACE FUNCTION public.staff_pending_items(p_user uuid)
 RETURNS TABLE(kind text, row_id uuid, col text, applicant_id uuid, applicant_name text, item_date date, detail text, can_reassign boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_manager_plus() then raise exception 'マネージャー以上だけが見られます' using errcode = '42501'; end if;
  return query
    select 'leave'::text, l.id, 'approver_id'::text, l.user_id, p.name, l.start_date, l.leave_type, true
      from leave_requests l left join profiles p on p.id = l.user_id
     where l.approver_id = p_user and l.status = 'pending'
    union all
    select 'leave', l.id, 'approver2_id', l.user_id, p.name, l.start_date, l.leave_type, true
      from leave_requests l left join profiles p on p.id = l.user_id
     where l.approver2_id = p_user and l.status in ('pending', 'manager_approved')
    union all
    select 'overtime', o.id, 'reviewer_id', o.applicant_id, p.name, o.work_date, o.status, true
      from overtime_reports o left join profiles p on p.id = o.applicant_id
     where o.reviewer_id = p_user and o.status not in ('confirmed', 'cancelled')
       and o.applicant_id is distinct from p_user          -- 本人が自分を申請先にしている記録は付け替えない
    union all
    select 'shift', s.id, 'reviewer_id', s.applicant_id, p.name, s.work_date, null::text, true
      from shift_reports s left join profiles p on p.id = s.applicant_id
     where s.reviewer_id = p_user and s.status in ('pending', 'resubmitted', 'requested')
    union all
    select 'purchase', r.id, ''::text, r.user_id, p.name, r.created_at::date, r.item_name, false
      from purchase_requests r left join profiles p on p.id = r.user_id
     where (r.status = 'pending_leader'  and r.leader_id = p_user)
        or (r.status = 'pending_manager' and p_user = any (coalesce(r.requested_manager_ids, '{}')))
        or (r.status = 'pending_board'   and p_user = any (coalesce(r.board_approver_ids, '{}')))
     order by 6, 1;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.staff_leave_reassign(p_user uuid, p_items jsonb)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  it jsonb;
  v_kind text; v_row uuid; v_col text; v_to uuid;
  v_applicant uuid; v_date date; v_label text; v_src text;
  v_to_name text; v_app_name text;
  v_n integer := 0;
begin
  if not is_admin() then raise exception '管理者だけが操作できます' using errcode = '42501'; end if;
  if jsonb_typeof(p_items) is distinct from 'array' then raise exception '付け替えの内容が読めません'; end if;

  for it in select * from jsonb_array_elements(p_items) loop
    v_kind := it ->> 'kind'; v_row := (it ->> 'row_id')::uuid; v_col := it ->> 'col'; v_to := (it ->> 'to')::uuid;
    if v_to is null or v_to = p_user then raise exception '付け替え先を選んでください'; end if;
    if not exists (select 1 from profiles where id = v_to and is_active) or staff_on_leave(v_to) then
      raise exception '付け替え先に選べない方が含まれています。選び直してください。';
    end if;
    select name into v_to_name from profiles where id = v_to;

    if v_kind = 'leave' and v_col = 'approver_id' then
      update leave_requests set approver_id = v_to
       where id = v_row and approver_id = p_user and status = 'pending'
      returning user_id, start_date into v_applicant, v_date;
      v_label := '休暇申請'; v_src := 'leave_request';
    elsif v_kind = 'leave' and v_col = 'approver2_id' then
      update leave_requests set approver2_id = v_to
       where id = v_row and approver2_id = p_user and status in ('pending', 'manager_approved')
      returning user_id, start_date into v_applicant, v_date;
      v_label := '休暇申請'; v_src := 'leave_request';
    elsif v_kind = 'overtime' and v_col = 'reviewer_id' then
      update overtime_reports set reviewer_id = v_to
       where id = v_row and reviewer_id = p_user and status not in ('confirmed', 'cancelled') and applicant_id is distinct from p_user
      returning applicant_id, work_date into v_applicant, v_date;
      v_label := '残業申請'; v_src := 'overtime_request';
    elsif v_kind = 'shift' and v_col = 'reviewer_id' then
      update shift_reports set reviewer_id = v_to
       where id = v_row and reviewer_id = p_user and status in ('pending', 'resubmitted', 'requested', 'request_confirmed')
      returning applicant_id, work_date into v_applicant, v_date;
      v_label := '勤務変更報告'; v_src := 'shift_report';
    else
      raise exception '付け替えできない申請が含まれています';
    end if;

    if v_applicant is null then
      raise exception 'すでに処理された申請が含まれています。画面を開き直してください。';
    end if;

    insert into staff_leave_reassignments (leave_user_id, table_name, row_id, column_name, to_user_id, done_by)
    values (p_user, case v_kind when 'leave' then 'leave_requests' when 'overtime' then 'overtime_reports' else 'shift_reports' end,
            v_row, v_col, v_to, auth.uid());

    select name into v_app_name from profiles where id = v_applicant;
    -- 新しい受理者へ（受理待ちのベル・押すと受理の画面）
    insert into notifications (user_id, message, source_type, reference_id, created_by)
    values (v_to, '🔁 ' || coalesce(v_app_name, '') || 'さんの' || v_label || '（' || to_char(v_date, 'FMMM/FMDD') || '）の受理者が、あなたに変わりました。',
            v_src || ':pending_approval', v_row, auth.uid());
    -- 申請者へ（結果のベル）。本人が新しい受理者のときは送らない
    if v_applicant is distinct from v_to then
      insert into notifications (user_id, message, source_type, reference_id, created_by)
      values (v_applicant, '🔁 ' || to_char(v_date, 'FMMM/FMDD') || ' の' || v_label || 'の受理者が ' || coalesce(v_to_name, '') || ' に変わりました。',
              v_src, v_row, auth.uid());
    end if;

    v_n := v_n + 1;
    v_applicant := null;
  end loop;
  return v_n;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.staff_leave_daily_notices()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_now    timestamp := now() at time zone 'Asia/Tokyo';
  v_today  date := (now() at time zone 'Asia/Tokyo')::date;
  v_days   int[];
  v_hour   int;
  v_minute int;
  v_n      integer := 0;
  l        record;
  v_cnt    integer;
  v_ins    integer;
  v_msg    text;
  v_src    text;
  v_name   text;
  v_base   date;
  v_start_rest  integer;
  v_return_rest integer;
  v_pending     integer;
begin
  select days_before, send_hour, send_minute into v_days, v_hour, v_minute
    from reminder_days_settings where event_key = 'leave_checklist_notify';
  v_days := coalesce(v_days, array[7, 3, 1]);
  -- 送る時刻より前なら何もしない（cron は5分ごと）
  if v_now < v_today + make_time(coalesce(v_hour, 9), coalesce(v_minute, 0), 0) then
    return 0;
  end if;
  delete from leave_notify_log where on_date < v_today - 400;

  for l in
    select sl.*, p.name as person_name
      from staff_leaves sl join profiles p on p.id = sl.user_id
     where sl.cancelled_at is null and p.is_active
       and sl.end_reason is distinct from 'retired'
       -- 終わっていない休職と、復職の日が今日の休職（0:00 の leave_sync が復職日に閉じる・早く戻った日も）
       and (sl.ended_at is null or leave_checklist_return_base(sl.id) = v_today)
  loop
    begin
      v_msg := null; v_src := null;
      v_name := regexp_replace(coalesce(l.person_name, ''), '[[:space:]　]+', ' ', 'g');
      v_base := leave_checklist_return_base(l.id);
      v_start_rest  := case when l.ended_at is null then leave_checklist_remaining(l.id, 'start') else 0 end;
      v_return_rest := leave_checklist_remaining(l.id, 'return');

      if l.ended_at is null and l.start_date = v_today then
        -- 休職の初日：受理待ちと、休職に入るときの残り
        select (select count(*) from leave_requests where approver_id = l.user_id and status = 'pending')
             + (select count(*) from leave_requests where approver2_id = l.user_id and status in ('pending', 'manager_approved'))
             + (select count(*) from overtime_reports where reviewer_id = l.user_id and status not in ('confirmed', 'cancelled') and applicant_id is distinct from l.user_id)
             + (select count(*) from shift_reports where reviewer_id = l.user_id and status in ('pending', 'resubmitted', 'requested'))
          into v_pending;
        if v_pending > 0 then
          v_msg := format('📋 %sさんの休職が今日から始まりました。受理待ち%s件の付け替え%sをお願いします。', v_name, v_pending,
                          case when v_start_rest > 0 then format('と、休職に入るときの手続き（残り%s件）', v_start_rest) else '' end);
          v_src := 'staff_leave:pending';
        elsif v_start_rest > 0 then
          v_msg := format('📋 %sさんの休職が今日から始まりました。休職に入るときの手続きが残り%s件あります。', v_name, v_start_rest);
          v_src := 'leave:remind';
        end if;
      elsif l.ended_at is null and l.return_date is not null and (l.return_date - 7 = v_today or l.return_date - 1 = v_today) then
        -- 復職日の7日前と前日（日付の直し忘れを防ぐ・いつも）。復職するときの残りがあれば同じ1通に
        v_msg := format('📋 %sさんが %s に復職予定です。%s日付が変わる場合は、管理者が［休職を修正］から直します。', v_name,
                        to_char(l.return_date, 'FMMM/FMDD'),
                        case when v_return_rest > 0 then format('復職するときの手続きが残り%s件あります。', v_return_rest) else '' end);
        v_src := 'staff_leave:return_soon';
      elsif l.ended_at is null and l.start_date > v_today and (l.start_date - v_today) = any (v_days) and v_start_rest > 0 then
        -- 休職の初日の◯日前：休職に入るときの残りがあるときだけ
        v_msg := format('📋 %sさんは %s から休職です。休職に入るときの手続きが残り%s件あります。', v_name, to_char(l.start_date, 'FMMM/FMDD'), v_start_rest);
        v_src := 'leave:remind';
      elsif v_base is not null and v_return_rest > 0 and (v_base = v_today or (v_base > v_today and (v_base - v_today) = any (v_days))) then
        -- 復職の日の◯日前・当日：復職するときの残りがあるときだけ
        v_msg := case when v_base = v_today
                      then format('📋 %sさんが今日復職しました。復職するときの手続きが残り%s件あります。', v_name, v_return_rest)
                      else format('📋 %sさんが %s に復職予定です。復職するときの手続きが残り%s件あります。', v_name, to_char(v_base, 'FMMM/FMDD'), v_return_rest) end;
        v_src := 'leave:remind';
      end if;

      if v_msg is not null then
        insert into leave_notify_log (notice_key, on_date) values (l.id::text, v_today) on conflict do nothing;
        get diagnostics v_ins = row_count;
        if v_ins > 0 then
          insert into notifications (user_id, message, source_type, reference_id, read)
          select r, v_msg, v_src, l.user_id::text, false from leave_checklist_recipients(l.user_id) r;
          get diagnostics v_cnt = row_count; v_n := v_n + v_cnt;
        end if;
      end if;
    exception when others then
      -- 🚨 1人の失敗でほかの人のお知らせを止めない
      raise warning '[staff_leave_daily_notices] % のお知らせに失敗しました: %', l.id, sqlerrm;
    end;
  end loop;

  -- 毎月1日：復職日が未定の休職中の方
  if extract(day from v_today) = 1 then
    begin
      select count(*) into v_cnt from staff_leaves sl join profiles p on p.id = sl.user_id
       where sl.ended_at is null and sl.cancelled_at is null and sl.return_date is null and sl.start_date <= v_today and p.is_active;
      if v_cnt > 0 then
        insert into leave_notify_log (notice_key, on_date) values ('undecided', v_today) on conflict do nothing;
        get diagnostics v_ins = row_count;
        if v_ins > 0 then
          insert into notifications (user_id, message, source_type, reference_id, read)
          select x.id, '📋 復職日が未定の方が' || v_cnt || '人います。', 'staff_leave:undecided', to_char(v_today, 'YYYY-MM-DD'), false
            from (select p.id from profiles p where p.is_active and role_is_manager_plus(p.id) and not staff_on_leave(p.id)
                  union select staff_admin_ids()) x;
          get diagnostics v_cnt = row_count; v_n := v_n + v_cnt;
        end if;
      end if;
    exception when others then
      raise warning '[staff_leave_daily_notices] 復職日が未定のお知らせに失敗しました: %', sqlerrm;
    end;
  end if;
  return v_n;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.retire_apply(p_user uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_admin uuid;
  v_n integer := 0;
  v_c integer;
  v_app_role text;
begin
  -- 在籍中で、退職日が入っていて、承認待ちではない人だけ
  update profiles p
     set is_active = false,
         retired_at = now(),
         retired_role_id = p.role_id,
         retired_employment_type = p.employment_type,
         retiree_access_until = coalesce(p.retiree_access_until, retire_access_default(p.retire_date))
   where p.id = p_user
     and p.is_active = true
     and p.retire_date is not null
     and coalesce(p.approval_status, '') <> 'pending';
  if not found then return 0; end if;

  -- 🚨 ここからの2つは、付け替え先の管理者が見つからなくても必ず行う（下の return 0 より前に置くこと）
  -- ① 管理者の権限を外す（ログインの鍵に入る app_metadata.role を消す）。復活で戻せるよう控えを残す
  select u.raw_app_meta_data ->> 'role' into v_app_role from auth.users u where u.id = p_user;
  if v_app_role is not null then
    update profiles set retired_app_role = v_app_role where id = p_user;
    update auth.users set raw_app_meta_data = raw_app_meta_data - 'role' where id = p_user;
  end if;
  -- ② いま開いている画面を止める（セッションを消す。更新用の鍵は連動して消える）
  delete from auth.sessions where user_id = p_user;

  -- 付け替え先＝「管理者」アカウント（app_metadata.role='admin' かつ在籍・本人以外）。
  -- 🚨 2026-09-18 時点で1つだけ。複数あれば最も古いもの。無ければ付け替えない（記録も残さない）
  select u.id into v_admin
    from auth.users u join profiles pr on pr.id = u.id
   where u.raw_app_meta_data->>'role' = 'admin' and pr.is_active = true and u.id <> p_user
   order by u.created_at
   limit 1;
  if v_admin is null then return 0; end if;

  -- 残業：確定・取り消し以外は、まだ確認者が関わる
  with t as (
    update overtime_reports set reviewer_id = v_admin
     where reviewer_id = p_user and status not in ('confirmed', 'cancelled')
    returning id)
  insert into retire_reassignments (retired_user_id, table_name, row_id, column_name, to_user_id)
  select p_user, 'overtime_reports', id, 'reviewer_id', v_admin from t;
  get diagnostics v_c = row_count; v_n := v_n + v_c;

  -- 勤務変更報告：確認待ち
  with t as (
    update shift_reports set reviewer_id = v_admin
     where reviewer_id = p_user and status in ('pending', 'resubmitted', 'requested', 'request_confirmed')
    returning id)
  insert into retire_reassignments (retired_user_id, table_name, row_id, column_name, to_user_id)
  select p_user, 'shift_reports', id, 'reviewer_id', v_admin from t;
  get diagnostics v_c = row_count; v_n := v_n + v_c;

  -- 休暇：1人目・2人目の承認者（受理前）
  with t as (
    -- 🚨 1人目は「まだ受理していない」行だけ（manager_approved は1人目がもう受理済み＝受理した人の記録を書き換えない・2026-09-19 レビュー）
    update leave_requests set approver_id = v_admin
     where approver_id = p_user and status = 'pending'
    returning id)
  insert into retire_reassignments (retired_user_id, table_name, row_id, column_name, to_user_id)
  select p_user, 'leave_requests', id, 'approver_id', v_admin from t;
  get diagnostics v_c = row_count; v_n := v_n + v_c;

  with t as (
    update leave_requests set approver2_id = v_admin
     where approver2_id = p_user and status in ('pending', 'manager_approved')
    returning id)
  insert into retire_reassignments (retired_user_id, table_name, row_id, column_name, to_user_id)
  select p_user, 'leave_requests', id, 'approver2_id', v_admin from t;
  get diagnostics v_c = row_count; v_n := v_n + v_c;

  -- 🚨 備品購入申請（承認者が複数・承認済みの人と未承認の人が混ざる）は自動では付け替えない。
  --    チェック表に「未処理の申請」として出し、既存の［承認者を変更］で直す（2026-09-19）
  return v_n;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.payroll_close_compose(p_user uuid, p_close date)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_p record; v_retiree boolean := false; v_keys jsonb := null; v_part boolean;
  v_ot boolean; v_sh boolean; v_ex boolean; v_otp int := 0; v_srp int := 0;
  v_period_start date;
begin
  select pr.id, pr.is_active, pr.employment_type into v_p from public.profiles pr where pr.id = p_user;
  if not found then return '[]'::jsonb; end if;
  -- 「管理者」の共用アカウントには送らない（2026-10-14 ユーザー確定）
  if exists (select 1 from auth.users u where u.id = p_user and (u.raw_app_meta_data ->> 'role') = 'admin') then
    return '[]'::jsonb;
  end if;
  if not coalesce(v_p.is_active, false) then
    -- 退職して申請できる期間中の人には送る（2026-10-14 ユーザー確定）。入社予定・それ以外の在籍していない人には送らない
    if not public.is_retiree_in_grace(p_user) then return '[]'::jsonb; end if;
    v_retiree := true;
    select coalesce(s.value -> 'keys', '[]'::jsonb) into v_keys from public.app_settings s where s.key = 'retiree_feature_keys';
    v_keys := coalesce(v_keys, '[]'::jsonb);
  end if;
  -- 休職（2026-10-20・ユーザー確定）：給与期間（前の月の16日〜締め日）がまるごと休職中なら送らない
  v_period_start := ((p_close - interval '1 month')::date + 1);
  if not v_retiree and public.staff_leave_active_on(p_user, v_period_start) and public.staff_leave_active_on(p_user, p_close)
     and exists (select 1 from public.staff_leaves l
                  where l.user_id = p_user and l.cancelled_at is null and l.start_date <= v_period_start
                    and (l.return_date is null or l.return_date > p_close)
                    and (l.ended_at is null or (l.ended_at at time zone 'Asia/Tokyo')::date > p_close)) then
    return '[]'::jsonb;
  end if;
  v_part := coalesce(v_p.employment_type, '正社員') = 'パート';
  v_ot := public.payroll_close_feature_on(p_user, 'overtime')     and (not v_retiree or v_keys ? 'overtime');
  v_sh := public.payroll_close_feature_on(p_user, 'shift_report') and (not v_retiree or v_keys ? 'shift_report') and v_part;
  v_ex := public.payroll_close_feature_on(p_user, 'expense')      and (not v_retiree or v_keys ? 'expense');
  -- 休職中は受理まち・確認まちを数えない（残った申請は経理へ回る・2026-10-20）
  if not v_retiree and not public.staff_on_leave(p_user) then
    -- 受理まち：ナビの数え方（App.tsx useOvertimePendingCount）に、締め日までの勤務・自分あて以外の条件を足したもの
    select count(*) into v_otp from public.overtime_reports o
     where o.reviewer_id = p_user and o.reviewer_id <> o.applicant_id and o.entry_type = 'manual'
       and o.status in ('requested', 'reported') and o.work_date <= p_close;
    -- 確認まち：ナビの数え方（useShiftPendingCount）に、締め日までの勤務の条件を足したもの
    select count(*) into v_srp from public.shift_reports s
     where s.reviewer_id = p_user and s.reviewer_id <> s.applicant_id
       and s.status in ('pending', 'resubmitted', 'requested', 'request_confirmed') and s.work_date <= p_close;
  end if;
  return public.payroll_close_lines(p_close, v_ot, v_sh, v_ex, v_ex and not v_part, v_otp, v_srp, null);
end $function$
;

CREATE OR REPLACE FUNCTION public.staff_absence_export()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_token text := nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-export-token';
  v_id uuid;
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_until date := (now() at time zone 'Asia/Tokyo')::date + 34;
  v_now text := to_char(now() at time zone 'Asia/Tokyo', 'YYYY/MM/DD HH24:MI');
  v_body text;
begin
  if v_token is null or length(v_token) < 32 then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select id into v_id from staff_export_tokens
   where token_sha256 = encode(sha256(convert_to(v_token, 'UTF8')), 'hex') and revoked_at is null;
  if v_id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update staff_export_tokens set last_used_at = now() where id = v_id;

  with
  -- ① 休暇申請（leave_dates があればその日だけ・無ければ開始〜終了）
  lv as (
    select l.user_id, x.d, '休み（終日）'::text as kind, ''::text as tm,
           case when l.status = 'approved' then '受理済み' else '受理待ち' end as st, '休暇申請'::text as src
      from leave_requests l
      cross join lateral (
        select e::date as d
          from jsonb_array_elements_text(case when coalesce(l.leave_dates, '') ~ '^\s*\[\s*"' then l.leave_dates::jsonb else '[]'::jsonb end) e
        union
        select g::date
          from generate_series(l.start_date, l.end_date, interval '1 day') g
         where coalesce(l.leave_dates, '') !~ '^\s*\[\s*"'
      ) x
     where l.status not in ('cancelled', 'rejected')
       and l.end_date >= v_today and l.start_date <= v_until
  ),
  -- ② 残業申請（休暇から自動で作った行は①と重なるので除く）
  ot as (
    select o.*,
           case when o.status in ('request_confirmed', 'reported', 'confirmed') then '受理済み' else '受理待ち' end as st
      from overtime_reports o
     where o.status not in ('cancelled', 'returned') and o.source_leave_request_id is null
       and (o.work_date between v_today and v_until or o.furikae_origin_date between v_today and v_until)
  ),
  ots as (  -- 時間帯：実績があれば実績・無ければ予定
    select o.id, min(s.start_min) as smin, max(s.end_min) as emax
      from ot o
      join overtime_report_segments s on s.report_id = o.id
       and s.phase = case when exists (select 1 from overtime_report_segments z where z.report_id = o.id and z.phase = 'actual')
                          then 'actual' else 'planned' end
     group by o.id
  ),
  otr as (
    select o.applicant_id as user_id, o.work_date as d, k.kind,
           case k.kind
             when '遅出' then coalesce(lpad((t2.smin / 60)::text, 2, '0') || ':' || lpad((t2.smin % 60)::text, 2, '0') || '〜', '')
             when '早退' then coalesce('〜' || lpad((t2.emax / 60)::text, 2, '0') || ':' || lpad((t2.emax % 60)::text, 2, '0'), '')
             when '勤務地変更' then coalesce(o.location, '')
             when '休日出勤' then trim(coalesce(lpad((t2.smin / 60)::text, 2, '0') || ':' || lpad((t2.smin % 60)::text, 2, '0')
                                      || '〜' || lpad((t2.emax / 60)::text, 2, '0') || ':' || lpad((t2.emax % 60)::text, 2, '0'), '')
                                 || ' ' || coalesce(o.location, ''))
             else '' end as tm,
           o.st, '残業申請'::text as src
      from ot o
      left join ots t2 on t2.id = o.id
      cross join lateral unnest(o.application_types) t
      cross join lateral (select case
             when t in ('chosei_off', 'furikae_off') then '休み（終日）'
             when t = 'absence' then '欠勤（終日）'
             when t in ('late_start_adj', 'tardiness') then '遅出'
             when t in ('early_end_adj', 'early_leave') then '早退'
             when t = 'location_change' then '勤務地変更'
             when t = 'holiday_work' then '休日出勤'
           end as kind) k
     where k.kind is not null and o.work_date between v_today and v_until
    union all
    -- 振替休日の振替元の日（その日は休日出勤）
    select o.applicant_id, o.furikae_origin_date, '休日出勤',
           trim(coalesce(to_char(o.furikae_origin_start, 'HH24:MI') || '〜' || to_char(o.furikae_origin_end, 'HH24:MI'), '')
                || ' ' || coalesce(o.furikae_origin_location, '')),
           o.st, '残業申請'
      from ot o
     where 'furikae_off' = any(o.application_types)
       and o.furikae_not_worked_at is null   -- 「この日は勤務しませんでした」と伝えた振替元の日は出さない
       and o.furikae_origin_date between v_today and v_until
  ),
  -- ③ 勤務変更（パート）
  srr as (
    select s.applicant_id as user_id, s.work_date as d, k.kind,
           case k.kind
             when '遅出' then coalesce(to_char(s.actual_start, 'HH24:MI') || '〜', '')
             when '早退' then coalesce('〜' || to_char(s.actual_end, 'HH24:MI'), '')
             when '勤務地変更' then coalesce(s.actual_location, '')
             when '休日出勤' then trim(coalesce(to_char(s.actual_start, 'HH24:MI') || '〜' || to_char(s.actual_end, 'HH24:MI'), '')
                                 || ' ' || coalesce(s.actual_location, ''))
             else '' end as tm,
           case when s.status in ('confirmed', 'request_confirmed') then '受理済み' else '受理待ち' end as st, '勤務変更'::text as src
      from shift_reports s
      cross join lateral unnest(coalesce(s.application_types, array[s.application_type])) t
      cross join lateral (select case
             when t = 'absence' then '欠勤（終日）'
             when t = 'tardiness' then '遅出'
             when t = 'early_leave' then '早退'
             when t = 'location_change' then '勤務地変更'
             when t = 'holiday_work' then '休日出勤'
           end as kind) k
     where k.kind is not null and s.status not in ('cancelled', 'returned')
       and s.work_date between v_today and v_until
  ),
  -- ④ 勤怠カレンダー（上長が入れたもの＝受理済み）
  atr as (
    select a.user_id, a.date as d, k.kind,
           case k.kind
             when '遅出' then coalesce(coalesce(a.work_segments -> 0 ->> 'start', to_char(a.actual_time, 'HH24:MI')) || '〜', '')
             when '早退' then coalesce('〜' || coalesce(a.work_segments -> -1 ->> 'end', to_char(a.actual_time, 'HH24:MI')), '')
             when '勤務地変更' then coalesce(a.location, '')
             when '休日出勤' then trim(coalesce((a.work_segments -> 0 ->> 'start') || '〜' || (a.work_segments -> -1 ->> 'end'), '')
                                 || ' ' || coalesce(a.location, ''))
             when '時間変更' then trim(coalesce((a.work_segments -> 0 ->> 'start') || '〜' || (a.work_segments -> -1 ->> 'end'), '')
                                 || ' ' || coalesce(a.location, ''))
             else '' end as tm,
           '受理済み'::text as st, '勤怠カレンダー'::text as src
      from attendance_exceptions a
      cross join lateral (select case
             when a.type = 'absent' then '欠勤（終日）'
             when a.type in ('late', 'late_start') then '遅出'
             when a.type in ('early_end', 'early_leave') then '早退'
             when a.type = 'location_change' then '勤務地変更'
             when a.type = 'holiday_work' then '休日出勤'
             when a.type = 'time_change' then '時間変更'
           end as kind) k
     where k.kind is not null and a.date between v_today and v_until
  ),
  -- ⑤ 休職（判定は staff_leave_active_on と同じ決め方：復職日と終わった日は休職に数えない）
  slr as (
    select l.user_id, g::date as d, '休み（終日）'::text as kind, ''::text as tm, '受理済み'::text as st, '休職'::text as src
      from staff_leaves l
      cross join lateral generate_series(greatest(l.start_date, v_today), v_until, interval '1 day') g
     where l.cancelled_at is null
       and l.start_date <= v_until
       and (l.return_date is null or l.return_date > g::date)
       and (l.ended_at is null or (l.ended_at at time zone 'Asia/Tokyo')::date > g::date)
  ),
  -- ⑥ シフト調整で正社員の方が代わりに決まり、まだ残業申請を出していないもの（申請の依頼が open のまま）。
  --    出したら依頼は applied になり、②の残業申請として出る（二重にならない）。パートの方は勤怠カレンダー（④）に入るので対象外
  sar as (
    select a.user_id, s.target_date as d,
           case when (public.registered_shift_of(a.user_id, s.target_date)).id is null then '休日出勤' else '時間変更' end as kind,
           trim(coalesce((a.segments -> 0 ->> 'start') || '〜' || (a.segments -> -1 ->> 'end'), '')
                || ' ' || coalesce(a.segments -> 0 ->> 'location', '')) as tm,
           '受理待ち'::text as st, 'シフト調整'::text as src
      from shift_adjust_assignments a
      join shift_adjust_slots s on s.id = a.slot_id
      join application_requests r on r.id = a.application_request_id
     where a.kind = 'overtime_request' and s.status = 'decided' and r.status = 'open'
       and s.target_date between v_today and v_until
  ),
  allr as (
    select * from lv union all select * from otr union all select * from srr union all select * from atr union all select * from slr union all select * from sar
  ),
  rws as (
    select distinct r.d, p.employee_no, p.name, r.kind, r.tm, r.st, r.src,
           coalesce((public.registered_shift_of(p.id, r.d)).location, '') as home
      from allr r
      join profiles p on p.id = r.user_id and p.is_active
     where r.d between v_today and v_until
  ),
  lines as (
    select r.d, r.employee_no, r.name, r.kind, r.src,
           (select string_agg(case when f ~ '[",\r\n]' then '"' || replace(f, '"', '""') || '"' else f end, ',' order by i)
              from unnest(array[v_now, to_char(r.d, 'YYYY/MM/DD'), coalesce(r.employee_no, ''), coalesce(r.name, ''),
                                r.kind, r.tm, r.st, r.src, r.home]) with ordinality as u(f, i)) as line
      from rws r
  )
  select string_agg(line, E'\r\n' order by d, employee_no nulls last, name, kind, src, line)
    into v_body
    from lines;

  return '書き出した時刻,日付,従業員番号,名前,種類,時間,状態,どこから,ふだんの所属校' || E'\r\n'
         || coalesce(v_body || E'\r\n', '');
end;
$function$
;
