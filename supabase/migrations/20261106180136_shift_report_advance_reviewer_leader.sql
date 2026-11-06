-- ============================================================
-- 2026-11-06  勤務変更の事前申請：申請先をリーダー・マネージャー以上に（ユーザー確定）
-- ============================================================
-- ・enforce_shift_report_status（本番の実定義＝20261106142056 と同じことを確かめてから）に1か所足すだけ
-- ・判定は roles.is_leader_plus（リーダー・マネージャー・社長・管理者が true／フロア責任者は false）
-- ・ふだんの報告（確認待ち）の申請先は今までどおり（フロア責任者も選べる）
-- 🚨 画面の申請先の一覧（ShiftReportPage の事前申請のとき）も同じ条件。片方だけ直さない

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

  -- 事前申請の申請先はリーダー・マネージャー以上（roles.is_leader_plus・フロア責任者は外す）（2026-11-06 ユーザー確定）
  -- 出すとき・申請先を変えたとき・事前申請に戻したときだけ見る（今ある行をそのまま直すだけでは止めない）
  if new.status in ('requested', 'request_confirmed')
     and (tg_op = 'INSERT' or new.reviewer_id is distinct from old.reviewer_id or old.status not in ('requested', 'request_confirmed'))
     and not exists (select 1 from profiles p join roles r on r.id = p.role_id
                      where p.id = new.reviewer_id and r.is_leader_plus) then
    raise exception '事前申請の申請先は、リーダー・マネージャーから選んでください' using errcode = '22023';
  end if;

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

commit;
