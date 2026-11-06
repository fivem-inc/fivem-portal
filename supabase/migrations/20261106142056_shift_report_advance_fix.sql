-- ============================================================
-- 2026-11-06  勤務変更の事前申請の直し（UI/UX とシニアエンジニアの2体のレビュー・ユーザー確定 案A）
-- ============================================================
-- 見張り enforce_shift_report_status（本番の実定義から・20261106000727 の版）：
--  ① 受理済み（request_confirmed）の中身は、申請先（reviewer_id）の付け替え以外ご本人が書き換えられない
--     （前は時間の欄だけ止めていて、時間数・休憩・変更前の時刻・理由は書き換えられた＝上長が見ないまま給与に載った）
--  ② 事前申請（受理待ち）のまま中身を直すときも、出すときと同じ確かめ（先の日・欠勤／打刻忘れでない・上長の入力が無い日）
--     受理済み → 事前申請に戻すときも、上長の入力が無い日だけ
--  ③ 事前申請（差し戻しを含む）を「確認待ち」「出し直し」にするのは、その日になってから（前は出し直しの道で先の日のまま報告にできた）
--  ④ 代わりに出した人（submitted_by）も、ご本人と同じように直す・報告する・取り消すことができる
--  ⑤ 新しく事前申請を出すとき、受理の記録（confirmed_by・confirmed_at）は空にする
-- shift_report_finish_advance：代わりに出した人も押せる／［申請した変更はありませんでした］は申請を消す（削除の記録に残る）
-- shift_report_cancel_advance（新）：その日の前の取り消しは申請を消す（案A：その日にまた報告できるように・削除の記録に残る）。
--   受理済みを取り消したら、申請先にベル（スマホなし）
-- staff_pending_items・staff_leave_daily_notices：受理済みの事前申請も付け替えの一覧と数に
-- payroll_close_compose：受理済みの事前申請（ご本人の報告待ち）は上長の「確認まち」に数えない
-- 🚨 どれも本番の実定義から起こした。試しは begin/rollback で

begin;

create or replace function public.enforce_shift_report_status()
 returns trigger
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_types text[] := coalesce(new.application_types, array[new.application_type]);
  v_self boolean := new.applicant_id = auth.uid();
  -- ご本人か、代わりに出した人（2026-11-06）
  v_owner boolean := new.applicant_id = auth.uid() or new.submitted_by = auth.uid();
  v_body_changed boolean := false;
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
    if new.status = 'requested' then new.confirmed_by := null; new.confirmed_at := null; end if;
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
  -- 中身が変わったか（申請先の付け替え・更新時刻だけなら「変わっていない」）
  v_body_changed := (to_jsonb(new) - array['reviewer_id', 'updated_at', 'advance', 'request_confirmed_at', 'request_confirmed_by', 'planned'])
                    is distinct from (to_jsonb(old) - array['reviewer_id', 'updated_at', 'advance', 'request_confirmed_at', 'request_confirmed_by', 'planned']);

  if new.status is not distinct from old.status then
    -- ① 受理済みの事前申請の中身は、ご本人が書き換えられない（直すときは事前申請に戻す＝受理のやり直し）
    if old.status = 'request_confirmed' and not is_admin() and v_body_changed then
      raise exception '受理された事前申請は、内容を変更すると受理のやり直しになります' using errcode = '42501';
    end if;
    -- ② 事前申請（受理待ち）のまま直すときも、出すときと同じ確かめ
    if old.status = 'requested' and not is_admin() and v_body_changed then
      if new.work_date <= v_today then
        raise exception '今日・過ぎた日は「報告」で送ってください' using errcode = '22023';
      end if;
      if v_types && array['absence', 'missed_clock'] then
        raise exception '欠勤・打刻忘れは事前申請ではなく「報告」で送ってください' using errcode = '22023';
      end if;
      if exists (select 1 from attendance_exceptions a where a.user_id = new.applicant_id and a.date = new.work_date) then
        raise exception 'この日は上長が勤務の変更を入力しています。当日になったら報告してください' using errcode = '22023';
      end if;
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

  -- 事前申請に戻す：①事前申請の差し戻しを直して出し直す ②受理のあと、その日の前に内容を変える。先の日だけ・ご本人（代わりに出した人）か管理者
  if new.status = 'requested' then
    if (v_owner or is_admin()) and new.work_date > v_today
       and not (v_types && array['absence', 'missed_clock'])
       and (old.status = 'request_confirmed'
            or (old.status = 'returned' and old.advance and old.request_confirmed_at is null)) then
      if not is_admin() and exists (select 1 from attendance_exceptions a where a.user_id = new.applicant_id and a.date = new.work_date) then
        raise exception 'この日は上長が勤務の変更を入力しています。当日になったら報告してください' using errcode = '22023';
      end if;
      return new;
    end if;
    raise exception '事前申請に戻せるのは、先の日のご本人の申請だけです' using errcode = '42501';
  end if;

  -- ③ 事前申請（差し戻しを含む）→ 報告（確認待ち・出し直し）は、その日になってから
  if new.status in ('pending', 'resubmitted')
     and (old.status in ('requested', 'request_confirmed') or (old.status = 'returned' and old.advance)) then
    if new.work_date <= v_today and (v_owner or is_admin()) then return new; end if;
    raise exception '実績の報告は、その日になってから送ってください' using errcode = '22023';
  end if;

  -- 事前申請の取消：その日が来るまで（あとは［申請した変更はありませんでした］か管理者）
  if new.status = 'cancelled' and old.status in ('requested', 'request_confirmed') then
    if is_admin() or (v_owner and old.work_date > v_today) then return new; end if;
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

-- ［申請どおりでした（確定）］［申請した変更はありませんでした］
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
  -- ご本人・代わりに出した人・管理者（2026-11-06）
  if not found or (r.applicant_id <> auth.uid() and r.submitted_by <> auth.uid() and not is_admin()) then
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
    -- 案A（2026-11-06）：消す（同じ日にまた報告できるように）。削除の記録（application_deletion_log）に理由つきで残る
    perform set_config('app.delete_reason', '事前申請：申請した変更はありませんでした（いつもどおり勤務）', true);
    delete from shift_reports where id = p_id;
    perform set_config('app.delete_reason', '', true);
    return 'deleted';
  end if;
  raise exception '種類が違います' using errcode = '22023';
end;
$function$;
revoke execute on function public.shift_report_finish_advance(uuid, text) from public;
revoke execute on function public.shift_report_finish_advance(uuid, text) from anon;
grant execute on function public.shift_report_finish_advance(uuid, text) to authenticated;

-- その日の前の事前申請の取り消し（案A：消す・削除の記録に残る）。受理済みなら申請先にベル（スマホなし）
create or replace function public.shift_report_cancel_advance(p_id uuid)
returns text
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  r shift_reports%rowtype;
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_name text;
begin
  if auth.uid() is null then raise exception 'ログインしてください' using errcode = '42501'; end if;
  select * into r from shift_reports where id = p_id for update;
  if not found or (r.applicant_id <> auth.uid() and r.submitted_by <> auth.uid() and not is_admin()) then
    raise exception 'この申請は見つかりません' using errcode = '42501';
  end if;
  if r.status not in ('requested', 'request_confirmed') then
    raise exception '事前申請だけ、ここから取り消せます' using errcode = '22023';
  end if;
  if r.work_date <= v_today and not is_admin() then
    raise exception 'その日が来たため、取り消しはできません（［申請した変更はありませんでした］を使うか、管理者に依頼してください）' using errcode = '42501';
  end if;
  perform set_config('app.delete_reason', '事前申請の取り消し（その日の前）', true);
  delete from shift_reports where id = p_id;
  perform set_config('app.delete_reason', '', true);
  if r.status = 'request_confirmed' and r.reviewer_id is not null and r.reviewer_id <> auth.uid() then
    select p.name into v_name from profiles p where p.id = r.applicant_id;
    insert into notifications (user_id, message, sub_message, source_type, reference_id, read)
    values (r.reviewer_id,
            coalesce(v_name, '') || 'さんが勤務変更の事前申請を取り消しました',
            to_char(r.work_date, 'FMMM/FMDD') || '（受理済みの事前申請）',
            'shift_report', r.id, false);
  end if;
  return 'deleted';
end;
$function$;
revoke execute on function public.shift_report_cancel_advance(uuid) from public;
revoke execute on function public.shift_report_cancel_advance(uuid) from anon;
grant execute on function public.shift_report_cancel_advance(uuid) to authenticated;

-- 代わりに出した人（submitted_by）も、事前申請を直す・その日に報告できる（流れと日付は見張りが決める）
drop policy if exists proxy_update_advance on public.shift_reports;
create policy proxy_update_advance on public.shift_reports for update to authenticated
  using (submitted_by = auth.uid() and (status in ('requested', 'request_confirmed') or (status = 'returned' and advance)))
  with check (submitted_by = auth.uid() and status in ('requested', 'pending', 'resubmitted'));

-- 受理済みの事前申請も付け替えの一覧と数に（staff_leave_reassign・retire_apply とそろえる）
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
     where s.reviewer_id = p_user and s.status in ('pending', 'resubmitted', 'requested', 'request_confirmed')
    union all
    select 'purchase', r.id, ''::text, r.user_id, p.name, r.created_at::date, r.item_name, false
      from purchase_requests r left join profiles p on p.id = r.user_id
     where (r.status = 'pending_leader'  and r.leader_id = p_user)
        or (r.status = 'pending_manager' and p_user = any (coalesce(r.requested_manager_ids, '{}')))
        or (r.status = 'pending_board'   and p_user = any (coalesce(r.board_approver_ids, '{}')))
     order by 6, 1;
end;
$function$;

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
             + (select count(*) from shift_reports where reviewer_id = l.user_id and status in ('pending', 'resubmitted', 'requested', 'request_confirmed'))
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
$function$;

-- 受理済みの事前申請（ご本人の報告待ち）は上長の「確認まち」に数えない
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
       and s.status in ('pending', 'resubmitted', 'requested') and s.work_date <= p_close;
  end if;
  return public.payroll_close_lines(p_close, v_ot, v_sh, v_ex, v_ex and not v_part, v_otp, v_srp, null);
end $function$;

commit;
