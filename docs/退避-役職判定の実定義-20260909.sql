-- 退避：役職名を参照している本番の実定義（2026-09-09 段0の前に取得・読み取りのみ）
-- 戻すときは該当ブロックをそのまま流す。ポリシーは USING / WITH CHECK を create policy に組み直す。

-- ===== function : enforce_grant_request_validity =====
CREATE OR REPLACE FUNCTION public.enforce_grant_request_validity()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  d          date;
  v_pps      date;
  v_cutoff   date;
  v_deadline date;
  v_today    date := (now() at time zone 'Asia/Tokyo')::date;
begin
  if new.user_id <> auth.uid() and coalesce(current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'role', '') <> 'admin' then
    raise exception 'FORBIDDEN: 自分の依頼のみ作成できます';
  end if;

  foreach d in array new.work_dates loop
    if extract(day from d) >= 16 then
      v_pps := date_trunc('month', d)::date + 15;
    else
      v_pps := (date_trunc('month', d) - interval '1 month')::date + 15;
    end if;
    v_cutoff   := (date_trunc('month', v_pps + interval '1 month'))::date + 16;
    v_deadline := overtime_grant_deadline(v_pps);

    if v_today <= v_cutoff then
      raise exception 'NOT_LOCKED: %はまだ締め切り前のため依頼できません', to_char(d, 'YYYY/MM/DD')
        using errcode = 'check_violation';
    end if;
    if v_today > v_deadline then
      raise exception 'PAYOUT_PASSED: %の給与期間は給与データ確定日（%）を過ぎているため依頼できません。管理者にご相談ください', to_char(d, 'YYYY/MM/DD'), to_char(v_deadline, 'YYYY/MM/DD')
        using errcode = 'check_violation';
    end if;

    if exists (
      select 1 from overtime_submission_grants g
      where g.user_id = new.user_id and g.work_date = d and g.revoked_at is null
    ) then
      raise exception 'ALREADY_GRANTED: %は既に許可されています', to_char(d, 'YYYY/MM/DD')
        using errcode = 'check_violation';
    end if;

    if exists (
      select 1 from overtime_submission_grant_requests r
      where r.user_id = new.user_id and r.status = 'open' and d = any(r.work_dates)
    ) then
      raise exception 'DUPLICATE_REQUEST: %は既に依頼中です', to_char(d, 'YYYY/MM/DD')
        using errcode = 'check_violation';
    end if;
  end loop;

  return new;
end;
$function$


-- ===== function : is_leader =====
CREATE OR REPLACE FUNCTION public.is_leader()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from profiles
     where id = auth.uid()
       and role_title = 'リーダー'
       and is_active = true
  );
$function$


-- ===== function : is_manager_plus =====
CREATE OR REPLACE FUNCTION public.is_manager_plus()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select is_admin() or exists (
    select 1 from profiles
     where id = auth.uid()
       and role_title in ('マネージャー','社長','管理者')
       and is_active = true
  );
$function$


-- ===== function : notify_safety_urgent =====
CREATE OR REPLACE FUNCTION public.notify_safety_urgent(p_check_id uuid, p_target_user_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_title text;
  v_created_by uuid;
  v_name text;
  r record;
begin
  select title, created_by into v_title, v_created_by from safety_checks where id = p_check_id;
  select name into v_name from profiles where id = p_target_user_id;

  for r in
    select distinct x.id from (
      select v_created_by as id where v_created_by is not null
      union
      select p.id from profiles p
       where p.is_active = true
         and p.role_title in ('マネージャー', '社長', '管理者')
    ) x
    where x.id is not null and x.id <> p_target_user_id
  loop
    -- source_type を通常の安否確認と分ける。
    -- タップ先を「集計画面」に固定するため（通常の安否確認は自分が未回答なら
    -- 回答画面を優先する規則だが、これは他人の緊急を知らせる通知なので集計を先に出す）。
    insert into notifications (user_id, message, sub_message, source_type, reference_id, event_key, read)
    values (r.id,
            coalesce(v_name, 'スタッフ') || 'さんが助けを必要としています',
            v_title,
            'safety_check_urgent', p_check_id::text, 'safety:urgent', false);
  end loop;
end;
$function$


-- ===== function : overtime_role_rank =====
CREATE OR REPLACE FUNCTION public.overtime_role_rank(p_uid uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce((
    select case coalesce(r.name, p.role_title)
      when '社長' then 1 when '管理者' then 1 when 'マネージャー' then 2
      when 'リーダー' then 3 when 'フロア責任者' then 4 when '一般' then 5
      when 'パート' then 6 else 99 end
    from profiles p left join roles r on r.id = p.role_id where p.id = p_uid), 99);
$function$


-- ===== function : overtime_role_rank_target =====
CREATE OR REPLACE FUNCTION public.overtime_role_rank_target(p_uid uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce((
    select case coalesce(r.name, p.role_title)
      when '社長' then 1 when '管理者' then 1 when 'マネージャー' then 2
      when 'リーダー' then 3 when 'フロア責任者' then 4 when '一般' then 5
      when 'パート' then 6 else 1 end
    from profiles p left join roles r on r.id = p.role_id where p.id = p_uid), 1);
$function$


-- ===== function : overtime_threshold_over =====
CREATE OR REPLACE FUNCTION public.overtime_threshold_over(p_period date)
 RETURNS TABLE(user_id uuid, total_minutes integer, confirmed_minutes integer, threshold_minutes integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select t.user_id, t.planned_total, coalesce(t.confirmed_total, 0), th.v
  from overtime_planned_totals(p_period) t
  join profiles p on p.id = t.user_id
  cross join lateral (select overtime_threshold_for(t.user_id) as v) th
  where p.is_active = true
    and coalesce(p.employment_type, '') <> 'パート'
    and th.v is not null
    and t.planned_total > th.v;
$function$


-- ===== function : overtime_visible_roster =====
CREATE OR REPLACE FUNCTION public.overtime_visible_roster()
 RETURNS TABLE(id uuid, name text, group_names text[], role_title text, rank integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select p.id, p.name, p.group_names,
         coalesce(r.name, p.role_title), overtime_role_rank_target(p.id)
  from profiles p left join roles r on r.id = p.role_id
  where p.is_active and p.employment_type is not null and p.employment_type <> 'パート'
    and has_feature_permission('overtime_summary')
    and ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
         or overtime_role_rank_target(p.id) >= (select overtime_role_rank(auth.uid())));
$function$


-- ===== function : purchase_request_approval_progress =====
CREATE OR REPLACE FUNCTION public.purchase_request_approval_progress(p_ids uuid[])
 RETURNS TABLE(purchase_request_id uuid, answered integer, required integer, pending_ids uuid[], answers jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH me AS (
    SELECT
      auth.uid() AS uid,
      ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin') AS is_admin,
      (SELECT p.role_title FROM profiles p WHERE p.id = auth.uid()) AS role_title
  )
  SELECT
    r.id,
    ans.cnt,
    COALESCE(array_length(a.ids, 1), 0)::integer,
    CASE WHEN vis.can_see_names THEN pend.ids ELSE '{}'::uuid[] END,
    CASE WHEN vis.can_see_names THEN ans.detail ELSE '[]'::jsonb END
  FROM purchase_requests r
  CROSS JOIN me
  CROSS JOIN LATERAL (
    SELECT COALESCE(r.board_approver_ids, r.requested_manager_ids) AS ids
  ) a
  CROSS JOIN LATERAL (
    SELECT
      count(*)::integer AS cnt,
      COALESCE(
        jsonb_agg(jsonb_build_object('manager_id', o.manager_id, 'opinion', o.opinion) ORDER BY o.created_at),
        '[]'::jsonb
      ) AS detail
    FROM purchase_request_manager_opinions o
    WHERE o.purchase_request_id = r.id
      AND o.approval_round = r.approval_round
  ) ans
  CROSS JOIN LATERAL (
    SELECT COALESCE(array_agg(x), '{}'::uuid[]) AS ids
    FROM unnest(COALESCE(a.ids, '{}'::uuid[])) AS x
    WHERE NOT EXISTS (
      SELECT 1
      FROM purchase_request_manager_opinions o
      WHERE o.purchase_request_id = r.id
        AND o.approval_round = r.approval_round
        AND o.manager_id = x
    )
  ) pend
  CROSS JOIN LATERAL (
    SELECT (
      me.is_admin
      OR me.role_title IN ('マネージャー', '社長')
      OR me.uid = ANY(COALESCE(r.board_approver_ids, '{}'::uuid[]))
      OR me.uid = ANY(COALESCE(r.requested_manager_ids, '{}'::uuid[]))
    ) AS can_see_names
  ) vis
  WHERE r.id = ANY(p_ids)
    AND (
      r.user_id = me.uid
      OR me.uid = ANY(COALESCE(r.board_approver_ids, '{}'::uuid[]))
      OR me.uid = ANY(COALESCE(r.requested_manager_ids, '{}'::uuid[]))
      OR me.role_title IN ('マネージャー', '社長')
      OR me.is_admin
    );
$function$


-- ===== function : rename_role =====
CREATE OR REPLACE FUNCTION public.rename_role(p_role_id uuid, p_new_name text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_old_name text;
  v_new_name text := btrim(coalesce(p_new_name, ''));
  v_count    integer;
begin
  -- 🚨 管理者だけ。is_admin() は coalesce 済みだが、二重に包んでも害はない
  --    （null が返ると not null = null となり if が成立せず素通りするため）
  if not coalesce(is_admin(), false) then
    raise exception 'permission denied: admin only' using errcode = '42501';
  end if;

  if v_new_name = '' then
    raise exception '役職名を入力してください' using errcode = '22023';
  end if;

  select name into v_old_name from roles where id = p_role_id;
  if v_old_name is null then
    raise exception '対象の役職が見つかりません' using errcode = 'P0002';
  end if;

  -- 同じ名前が他にあると、あとで名前から役職を引けなくなる（権限判定が名前で引くため）
  if exists (select 1 from roles r where r.name = v_new_name and r.id <> p_role_id) then
    raise exception '同じ名前の役職がすでにあります' using errcode = '23505';
  end if;

  -- 名前が変わっていないなら何もしない（押し間違いで人数だけ0が返る）
  if v_old_name = v_new_name then
    return 0;
  end if;

  update roles set name = v_new_name where id = p_role_id;

  -- 🚨 role_title と role_id の両方を揃える。
  --    対象は「古い名前を持っている人」と「role_id がこの役職を指している人」の両方。
  --    どちらか片方しか合っていない人（26人いた）も、ここで揃う。
  update profiles
     set role_title = v_new_name,
         role_id    = p_role_id
   where role_title = v_old_name
      or role_id = p_role_id;
  get diagnostics v_count = row_count;

  return v_count;
end;
$function$


-- ===== function : resolve_role_recipients =====
CREATE OR REPLACE FUNCTION public.resolve_role_recipients(p_applicant uuid, p_recipient jsonb)
 RETURNS SETOF uuid
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_roles       text[];
  v_group_filter text;
  v_org_wide    text[];
  v_group_roles text[];
  v_owide_roles text[];
  v_teams       text[];
begin
  -- 既定は leave-approved-notify と同じ（設定が無いときの動き）
  v_roles        := coalesce(
                      (select array_agg(x) from jsonb_array_elements_text(p_recipient -> 'roles') x),
                      array['リーダー', 'マネージャー', '社長']);
  v_group_filter := coalesce(p_recipient ->> 'groupFilter', 'all');
  v_org_wide     := coalesce(
                      (select array_agg(x) from jsonb_array_elements_text(p_recipient -> 'orgWideRoles') x),
                      array['社長', '管理者']);

  -- 「申請者本人」は宛先の指定として使われるが、ここでは役職として引かない
  v_roles := array(select unnest(v_roles) except select '申請者本人');

  v_group_roles := array(select unnest(v_roles) except select unnest(v_org_wide));
  v_owide_roles := array(select unnest(v_roles) intersect select unnest(v_org_wide));

  -- 申請者の所属チーム（配信用グループを除く）
  select coalesce(array_agg(g), '{}')
    into v_teams
    from unnest(coalesce((select group_names from profiles where id = p_applicant), '{}')) g
   where g in (select value from master_options where category = 'shift_report_group');

  -- 🚨 マスタが1件も取れないときは絞り込みを諦めて全グループで判定する
  --    （誰にも届かないより安全側。既存3か所と同じ考え方）
  if not exists (select 1 from master_options where category = 'shift_report_group') then
    v_teams := coalesce((select group_names from profiles where id = p_applicant), '{}');
  end if;

  return query
    select p.id from profiles p
     where p.is_active = true
       and p.role_title = any(v_group_roles)
       and (v_group_filter <> 'same' or cardinality(v_teams) = 0 or p.group_names && v_teams)
       and p.id <> p_applicant
    union
    select p.id from profiles p
     where p.is_active = true
       and p.role_title = any(v_owide_roles)
       and p.id <> p_applicant;
end $function$


-- ===== function : room_can_use_basic_settings =====
CREATE OR REPLACE FUNCTION public.room_can_use_basic_settings()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case
    when (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' then true
    when not room_is_staff() then false
    else exists (
      select 1 from profiles p
       where p.id = auth.uid()
         and coalesce(p.role_title, '') = any (
           string_to_array(
             coalesce((select value from room_settings where key = 'basic_settings_roles'),
                      '一般,リーダー,フロア責任者,マネージャー,社長,管理者'),
             ','))
    )
  end;
$function$


-- ===== function : room_is_staff =====
CREATE OR REPLACE FUNCTION public.room_is_staff()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from profiles p
     where p.id = auth.uid()
       and coalesce(p.employment_type, '') <> 'パート'
  );
$function$


-- ===== function : send_overtime_clock_inquiry =====
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
end; $function$


-- ===== function : set_board_approver_ids =====
CREATE OR REPLACE FUNCTION public.set_board_approver_ids()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.amount > 30000 AND NEW.request_type = 'purchase_request' AND NOT NEW.president_self_judgment THEN
    IF TG_OP = 'INSERT' OR NEW.board_approver_ids IS NOT DISTINCT FROM OLD.board_approver_ids THEN
      SELECT array_agg(id) INTO NEW.board_approver_ids
        FROM public.profiles
        WHERE is_active = true
          AND role_title IN ('マネージャー', '社長')
          AND id != NEW.user_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$


-- ===== function : set_leave_request_enabled =====
CREATE OR REPLACE FUNCTION public.set_leave_request_enabled(p_user_id uuid, p_enabled boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- 🚨 is_admin() を使う（coalesce 済みで NULL を返さない）。
  --    exists も NULL を返さないので、or で組み合わせても汚染されない。
  if not (
    is_admin()
    or exists (
      select 1 from profiles
      where id = auth.uid()
        and role_title = any (array['リーダー', 'マネージャー', '社長', '管理者'])
    )
  ) then
    raise exception '休暇申請フォームを送る権限がありません';
  end if;

  update profiles
     set leave_request_enabled = p_enabled,
         leave_enabled_by = case when p_enabled then auth.uid() else null end
   where id = p_user_id;
end $function$


-- ===== function : set_leave_shift_adjust =====
CREATE OR REPLACE FUNCTION public.set_leave_shift_adjust(p_id uuid, p_status text)
 RETURNS TABLE(ok boolean, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role text;
  v_is_admin boolean;
  v_count int;
begin
  if p_status not in ('pending', 'adjusted', 'no_change') then
    return query select false, '状態の値が正しくありません'::text;
    return;
  end if;

  -- 🚨 管理者判定は必ず app_metadata->>'role'。'role' の直参照は常に false になる（過去に2回踏んでいる）
  -- 🚨🚨 coalesce を必ず付ける。app_metadata を持たない人（管理者以外はほぼ全員）だと
  --      この比較は false ではなく NULL になり、`NULL or false` は NULL、
  --      `if not NULL then` は成立しないため、役職チェックを素通りして更新まで進んでしまう。
  --      2026-09-09 の取り消しテストで、リーダー・一般・パートが全員変更できる状態だったのを発見した。
  v_is_admin := coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
  select role_title into v_role from profiles where id = auth.uid();

  -- 🚨 誰が変えられるかは管理画面「役職・機能権限」→ leave_shift_adjust で決める。
  --    役職名をここに書かない（序列の数値で「以上」を判定するのも禁止。
  --    並び順を変えたときにフロア責任者が自動的に入るため）。
  if not (v_is_admin or exists (
        select 1
          from feature_permissions fp
          join roles r on r.id = fp.role_id
         where fp.feature_key = 'leave_shift_adjust'
           and fp.enabled
           and r.name = coalesce(v_role, ''))) then
    return query select false, 'シフト調整の状態を変える権限がありません（管理画面の「役職・機能権限」で設定します）'::text;
    return;
  end if;

  -- 対象はマネージャー受理以降だけ（2026-09-09 ユーザー確定）。
  -- 🚨 有給は マネージャー受理 → 経理 → 社長 と受理が3段あるが、シフトを組むマネージャーが
  --    動けるのは1段目の時点なので、最終受理（approved）まで待たない。
  --    画面の出し分け・毎朝のお知らせの抽出条件も必ずこの3つに揃えること。
  update leave_requests
     set shift_adjust_status = p_status,
         shift_adjusted_at   = case when p_status = 'pending' then null else now() end,
         shift_adjusted_by   = case when p_status = 'pending' then null else auth.uid() end
   where id = p_id
     and status in ('manager_approved', 'admin_approved', 'approved');

  get diagnostics v_count = row_count;
  if v_count = 0 then
    return query select false, 'この休暇は受理前か、すでに取り消されています'::text;
    return;
  end if;

  return query select true, ''::text;
end $function$


-- ===== function : withdraw_overtime_clock_inquiry =====
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
end; $function$


-- ===== policy : announcements / announcements_admin_write =====
TABLE announcements
POLICY announcements_admin_write
CMD ALL
ROLES authenticated
USING (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role_title = '管理者'::text))))
WITH CHECK (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role_title = '管理者'::text))))

-- ===== policy : attendance_exceptions / Approvers can manage attendance_excepti =====
TABLE attendance_exceptions
POLICY Approvers can manage attendance_exceptions
CMD ALL
ROLES authenticated
USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text) OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role_title = ANY (ARRAY['リーダー'::text, 'マネージャー'::text, '社長'::text, '管理者'::text]))))))
WITH CHECK (none)

-- ===== policy : leave_requests / admin_insert_leave_requests =====
TABLE leave_requests
POLICY admin_insert_leave_requests
CMD INSERT
ROLES authenticated
USING (none)
WITH CHECK (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role_title = ANY (ARRAY['管理者'::text, '社長'::text])))))

-- ===== policy : leave_requests / approvers_can_read_leave_requests =====
TABLE leave_requests
POLICY approvers_can_read_leave_requests
CMD SELECT
ROLES authenticated
USING ((user_id = auth.uid()) OR (approver_id = auth.uid()) OR (approver2_id = auth.uid()) OR (((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text) OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role_title = '社長'::text)))))
WITH CHECK (none)

-- ===== policy : leave_requests / select_admin =====
TABLE leave_requests
POLICY select_admin
CMD SELECT
ROLES authenticated
USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text) OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role_title = ANY (ARRAY['リーダー'::text, 'マネージャー'::text, '社長'::text, '管理者'::text]))))))
WITH CHECK (none)

-- ===== policy : leave_requests / update_admin =====
TABLE leave_requests
POLICY update_admin
CMD UPDATE
ROLES public
USING (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role_title = ANY (ARRAY['リーダー'::text, 'マネージャー'::text, '社長'::text, '管理者'::text])))))
WITH CHECK (none)

-- ===== policy : notification_settings / 管理者のみ編集可能 =====
TABLE notification_settings
POLICY 管理者のみ編集可能
CMD ALL
ROLES public
USING (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role_title = ANY (ARRAY['管理者'::text, '社長'::text])))))
WITH CHECK (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role_title = ANY (ARRAY['管理者'::text, '社長'::text])))))

-- ===== policy : purchase_request_manager_opinions / opinion_select =====
TABLE purchase_request_manager_opinions
POLICY opinion_select
CMD SELECT
ROLES public
USING ((EXISTS ( SELECT 1
   FROM purchase_requests pr
  WHERE ((pr.id = purchase_request_manager_opinions.purchase_request_id) AND ((auth.uid() = ANY (pr.requested_manager_ids)) OR (auth.uid() = ANY (pr.board_approver_ids)))))) OR (EXISTS ( SELECT 1
   FROM profiles p
  WHERE ((p.id = auth.uid()) AND (p.role_title = ANY (ARRAY['マネージャー'::text, '社長'::text]))))) OR (visible_to_applicant AND (EXISTS ( SELECT 1
   FROM purchase_requests pr
  WHERE ((pr.id = purchase_request_manager_opinions.purchase_request_id) AND (pr.user_id = auth.uid()))))))
WITH CHECK (none)

-- ===== policy : purchase_requests / pr_manager_plus_select =====
TABLE purchase_requests
POLICY pr_manager_plus_select
CMD SELECT
ROLES public
USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text) OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role_title = ANY (ARRAY['マネージャー'::text, '社長'::text]))))))
WITH CHECK (none)

-- ===== policy : receipt_download_log / receipt_download_log_select =====
TABLE receipt_download_log
POLICY receipt_download_log_select
CMD SELECT
ROLES public
USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text) OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role_title = ANY (ARRAY['マネージャー'::text, '社長'::text]))))) OR (EXISTS ( SELECT 1
   FROM purchase_requests pr
  WHERE ((pr.id = receipt_download_log.purchase_request_id) AND (pr.user_id = auth.uid())))))
WITH CHECK (none)

-- ===== policy : shift_report_history / history_select =====
TABLE shift_report_history
POLICY history_select
CMD SELECT
ROLES authenticated
USING ((changed_by = auth.uid()) OR (((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text) OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role_title = ANY (ARRAY['リーダー'::text, 'マネージャー'::text, 'フロア責任者'::text, '社長'::text, '管理者'::text]))))))
WITH CHECK (none)

-- ===== policy : shift_reports / approver_delete =====
TABLE shift_reports
POLICY approver_delete
CMD DELETE
ROLES authenticated
USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text) OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role_title = ANY (ARRAY['リーダー'::text, 'マネージャー'::text, 'フロア責任者'::text, '社長'::text, '管理者'::text]))))))
WITH CHECK (none)

-- ===== policy : shift_reports / approver_select =====
TABLE shift_reports
POLICY approver_select
CMD SELECT
ROLES authenticated
USING ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text) OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role_title = ANY (ARRAY['リーダー'::text, 'マネージャー'::text, 'フロア責任者'::text, '社長'::text, '管理者'::text]))))))
WITH CHECK (none)

-- ===== policy : shift_reports / reviewer_confirm =====
TABLE shift_reports
POLICY reviewer_confirm
CMD UPDATE
ROLES authenticated
USING ((reviewer_id = auth.uid()) AND ((((auth.jwt() -> 'app_metadata'::text) ->> 'role'::text) = 'admin'::text) OR (EXISTS ( SELECT 1
   FROM profiles
  WHERE ((profiles.id = auth.uid()) AND (profiles.role_title = ANY (ARRAY['リーダー'::text, 'マネージャー'::text, 'フロア責任者'::text, '社長'::text, '管理者'::text])))))))
WITH CHECK (none)

-- ===== trigger : overtime_submission_grant_requests / trg_enforce_grant_request_ =====
CREATE TRIGGER trg_enforce_grant_request_validity BEFORE INSERT ON public.overtime_submission_grant_requests FOR EACH ROW EXECUTE FUNCTION enforce_grant_request_validity()

-- ===== trigger : purchase_requests / purchase_requests_set_board_approver_ids =====
CREATE TRIGGER purchase_requests_set_board_approver_ids BEFORE INSERT OR UPDATE ON public.purchase_requests FOR EACH ROW EXECUTE FUNCTION set_board_approver_ids()

