-- 管理画面「📊 レポート」の作り直し（2026-10-17・計画 docs/計画-レポートの作り直し.md）
-- ・集計に使う記録を、期間ごとに jsonb 1つにまとめて返す関数2本。🚨 管理者だけ（is_admin）。1つの値で返すので PostgREST の1,000件の打ち切りは関係ない
-- ・計算（残業の合計・36協定の目安・受理までの時間など）は画面の lib/reportCalc.ts で行う。
--   🚨 残業の数え方は本人のカードと同じ lib/overtimeBalance の computeBalance を使うので、ここでは記録をそのまま返す（数え方を DB と画面の2か所に書かない）
-- ・データは数百件・1回数十KB（管理者が開いたときだけ）。毎晩の集計表は作らない（必要になったら別に）
-- 🚨 名前は返さない（画面が profiles から読む＝管理者は今も読める）。新しい関数は anon と authenticated（管理者以外）から外す…ではなく、
--    authenticated には残し、関数の入口で管理者を確かめる（管理者も authenticated のため）

begin;

-- 残業・時間（overtime_reports）。p_from〜p_to は給与期間の初日（pay_period_start）
create or replace function public.report_overtime_data(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v jsonb;
begin
  if not coalesce(is_admin(), false) then
    raise exception 'REPORT_ADMIN_ONLY: 管理者だけが見られます' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 800 then
    raise exception 'REPORT_BAD_RANGE: 期間が正しくありません' using errcode = '22023';
  end if;

  select jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'a', r.applicant_id, 'wd', r.work_date, 'pp', r.pay_period_start, 'st', r.status, 'et', r.entry_type,
        'd', r.diff_minutes, 't', coalesce(to_jsonb(r.application_types), '[]'::jsonb), 'ph', r.is_post_hoc,
        'c', r.created_at, 'rc', r.request_confirmed_at, 'cf', r.confirmed_at,
        'self', (r.confirmed_by is not null and r.confirmed_by = r.applicant_id),
        'loc', r.location, 'ns', r.normal_shift, 'brk', r.break_minutes,
        'seg', coalesce((select jsonb_agg(jsonb_build_array(g.start_min, g.end_min) order by g.seg_no)
                           from overtime_report_segments g where g.report_id = r.id and g.phase = 'actual'), '[]'::jsonb)
      ) order by r.work_date)
      from overtime_reports r
      where r.pay_period_start between p_from and p_to
    ), '[]'::jsonb),
    -- 目安（人ごとの例外も含む・overtime_threshold_for・null＝対象外）。在籍の人だけ
    'thresholds', coalesce((
      select jsonb_object_agg(p.id, overtime_threshold_for(p.id)) from profiles p where p.is_active
    ), '{}'::jsonb),
    'settings', (select jsonb_build_object('threshold_minutes', s.threshold_minutes, 'banner_group_names', to_jsonb(s.banner_group_names))
                   from overtime_settings s where s.id = 1)
  ) into v;
  return v;
end;
$function$;
revoke execute on function public.report_overtime_data(date, date) from public;
revoke execute on function public.report_overtime_data(date, date) from anon;
grant execute on function public.report_overtime_data(date, date) to authenticated;

-- 現場・申請の流れ・休暇・交通費・備品・連絡板・安否（p_from〜p_to は日付の範囲）
create or replace function public.report_misc_data(p_from date, p_to date)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v jsonb;
begin
  if not coalesce(is_admin(), false) then
    raise exception 'REPORT_ADMIN_ONLY: 管理者だけが見られます' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to < p_from or p_to - p_from > 800 then
    raise exception 'REPORT_BAD_RANGE: 期間が正しくありません' using errcode = '22023';
  end if;

  select jsonb_build_object(
    -- 勤務変更（パートの方）
    'shift', coalesce((select jsonb_agg(jsonb_build_object(
        'a', s.applicant_id, 'wd', s.work_date, 'pp', s.pay_period_start, 'st', s.status,
        't', coalesce(to_jsonb(s.application_types), to_jsonb(array[s.application_type])),
        'os', s.original_start, 'oe', s.original_end, 'oseg', s.original_segments,
        'as', s.actual_start, 'ae', s.actual_end, 'aseg', s.actual_segments, 'lab', s.labor_minutes, 'brk', s.break_minutes,
        'loc', coalesce(s.actual_location, s.original_location),
        'c', s.created_at, 'cf', s.confirmed_at, 'self', (s.confirmed_by is not null and s.confirmed_by = s.applicant_id)))
      from shift_reports s where s.work_date between p_from and p_to), '[]'::jsonb),
    -- 勤怠カレンダーの予定（欠勤・遅刻・早退など）
    'att', coalesce((select jsonb_agg(jsonb_build_object('u', e.user_id, 'd', e.date, 'type', e.type, 'loc', e.location))
      from attendance_exceptions e where e.date between p_from and p_to), '[]'::jsonb),
    -- 休暇（日付は leave_dates・休んだ日で数える）。年度の有休を数えるため、日付が範囲に1日でも入るもの
    'leave', coalesce((select jsonb_agg(jsonb_build_object(
        'u', l.user_id, 'type', l.leave_type, 'st', l.status, 'dates', l.leave_dates, 'sd', l.start_date, 'ed', l.end_date,
        'c', l.created_at, 'ap', l.approved_at, 'ap2', l.approved2_at))
      from leave_requests l where coalesce(l.end_date, l.start_date) >= p_from and coalesce(l.start_date, l.end_date) <= p_to), '[]'::jsonb),
    -- 交通費（項目の日付・金額・種類）
    'expense', coalesce((select jsonb_agg(jsonb_build_object(
        'u', x.user_id, 'st', x.status, 'c', x.created_at, 'ap', x.approved_at, 'rj', x.rejected_at,
        'items', (select coalesce(jsonb_agg(jsonb_build_object('d', it->>'start_date', 'amt', it->>'amount', 'type', it->>'type')), '[]'::jsonb)
                    from jsonb_array_elements(x.expenses_data) it)))
      from expenses x where x.created_at >= p_from - 62 and x.created_at < p_to + 32), '[]'::jsonb),
    -- 備品
    'purchase', coalesce((select jsonb_agg(jsonb_build_object(
        'st', pr.status, 'type', pr.request_type, 'amt', coalesce(pr.amount, pr.items_subtotal), 'c', pr.created_at,
        'loc', pr.location, 'pay', pr.payment_method, 'paid', pr.reimbursed_at,
        'done', coalesce(pr.board_approved_at, pr.manager_approved_at, pr.leader_approved_at)))
      from purchase_requests pr where pr.created_at >= p_from and pr.created_at < p_to + 1), '[]'::jsonb),
    -- シフト調整の相談
    'adjust', coalesce((select jsonb_agg(jsonb_build_object('d', sa.target_date, 'cause', sa.cause, 'st', sa.status, 'c', sa.created_at, 'dc', sa.decided_at))
      from shift_adjust_slots sa where sa.target_date between p_from and p_to), '[]'::jsonb),
    -- 修正依頼
    'corr', coalesce((select jsonb_agg(jsonb_build_object('type', cr.target_type, 'kind', cr.request_kind, 'st', cr.status, 'c', cr.created_at, 'r', cr.resolved_at))
      from correction_requests cr where cr.created_at >= p_from and cr.created_at < p_to + 1), '[]'::jsonb),
    -- 連絡板のお知らせ（グループ・DM ではないもの）：届いた人数・読んだ人数・読まれるまでの時間（真ん中）・確認が必要なものの確認数
    'notice', coalesce((select jsonb_agg(jsonb_build_object(
        's', m.sent_at, 'n', rc.n, 'read', rd.n, 'med', rd.med, 'req', m.requires_confirmation, 'conf', cf.n))
      from board_messages m
      cross join lateral (select count(*) n from board_message_recipients x where x.message_id = m.id) rc
      cross join lateral (select count(*) n, percentile_cont(0.5) within group (order by extract(epoch from (b.read_at - m.sent_at)) / 60.0) med
                            from board_reads b join board_message_recipients x on x.message_id = b.message_id and x.user_id = b.user_id
                           where b.message_id = m.id and b.read_at >= m.sent_at) rd
      cross join lateral (select count(*) n from board_confirmations c where c.message_id = m.id) cf
      where m.channel_id is null and m.parent_id is null and m.status = 'sent' and m.sent_at >= p_from and m.sent_at < p_to + 1), '[]'::jsonb),
    -- 安否確認（試し・取り消しは除く）
    'safety', coalesce((select jsonb_agg(jsonb_build_object(
        'c', sc.created_at, 'n', (select count(*) from safety_check_recipients r where r.check_id = sc.id),
        'ans', (select count(*) from safety_check_responses r where r.check_id = sc.id), 'all', sc.all_answered_at))
      from safety_checks sc where not sc.is_test and not coalesce(sc.cancelled, false) and sc.created_at >= p_from and sc.created_at < p_to + 1), '[]'::jsonb)
  ) into v;
  return v;
end;
$function$;
revoke execute on function public.report_misc_data(date, date) from public;
revoke execute on function public.report_misc_data(date, date) from anon;
grant execute on function public.report_misc_data(date, date) to authenticated;

commit;
