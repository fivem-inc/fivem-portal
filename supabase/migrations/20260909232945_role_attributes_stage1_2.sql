-- 役職の属性化・段1（ヘルパー関数の中身）＋段2（役職名を直書きしていたRLSポリシー14本）。
-- 2026-09-09 ユーザー決定（docs/計画-役職の属性化.md §9：Q2=roles の列／Q3=sort_order が序列／Q5=B）。
--
-- 🚨 すべて本番の実定義（docs/退避-役職判定の実定義-20260909.sql）から起こしている。
-- 🚨 方針：いま含まれている役職の**集合をそのまま保つ**属性に割り当てる（挙動を変えない）。
--    唯一の意図的な変更は announcements_admin_write（役職名「管理者」→ システム管理者判定。Q5=B）。
--    管理者アカウントは app_metadata=admin を持つことを実測済みなので、今日の顔ぶれでは同じ結果になる。
--
-- 🚨 RLS から呼ぶ関数は anon の実行権を**外さない**（外すと未ログイン時にポリシー評価が失敗する。
--    has_feature_permission と同じ扱い）。

-- ========================================
-- 1) 役職の属性を引く中核関数（利用者IDを受ける版）。判定は全部ここを通す
--    🚨 exists / coalesce で NULL を返さない（NULL は `not` で素通りする）
-- ========================================
create or replace function public.role_is_approver(p_uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select r.is_approver from profiles p join roles r on r.id = p.role_id where p.id = p_uid), false);
$$;
create or replace function public.role_is_leader_plus(p_uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select r.is_leader_plus from profiles p join roles r on r.id = p.role_id where p.id = p_uid), false);
$$;
create or replace function public.role_is_manager_plus(p_uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select r.is_manager_plus from profiles p join roles r on r.id = p.role_id where p.id = p_uid), false);
$$;
create or replace function public.role_is_board_approver(p_uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select r.is_board_approver from profiles p join roles r on r.id = p.role_id where p.id = p_uid), false);
$$;
create or replace function public.role_is_org_wide(p_uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select r.is_org_wide from profiles p join roles r on r.id = p.role_id where p.id = p_uid), false);
$$;
-- 立場（leader / manager / accounting / president）。無ければ null
create or replace function public.role_acts_as(p_uid uuid) returns text
language sql stable security definer set search_path = public as $$
  select r.acts_as from profiles p join roles r on r.id = p.role_id where p.id = p_uid;
$$;
-- 序列。小さいほど上（既存の overtime_role_rank と同じ向き）。roles.sort_order は大きいほど上なので反転する。
-- 役職が無ければ null（呼び出し側で 99＝最下位 か 1＝最上位 を選ぶ。既存の fail-closed の使い分けを保つ）
create or replace function public.role_rank(p_uid uuid) returns integer
language sql stable security definer set search_path = public as $$
  select (select max(sort_order) from roles) + 1 - r.sort_order
    from profiles p join roles r on r.id = p.role_id where p.id = p_uid;
$$;

comment on function public.role_is_approver(uuid)       is '役職の属性「承認者」（2026-09-09 属性化・段1）';
comment on function public.role_is_leader_plus(uuid)    is '役職の属性「リーダー以上」（フロア責任者を含まない）';
comment on function public.role_is_manager_plus(uuid)   is '役職の属性「マネージャー以上」（管理者を含む）';
comment on function public.role_is_board_approver(uuid) is '役職の属性「決裁者」（🚨 管理者＝経理を含まない）';
comment on function public.role_is_org_wide(uuid)       is '役職の属性「経営」（グループ絞り込みの対象外）';
comment on function public.role_acts_as(uuid)           is '役職の立場（leader/manager/accounting/president）。非一意';
comment on function public.role_rank(uuid)              is '序列（小さいほど上）。roles.sort_order を反転したもの';

-- ========================================
-- 2) RLS から呼ぶ引数なしのラッパー（auth.uid() 版）
-- ========================================
create or replace function public.is_approver() returns boolean
language sql stable security definer set search_path = public as $$ select role_is_approver(auth.uid()); $$;
create or replace function public.is_leader_plus() returns boolean
language sql stable security definer set search_path = public as $$ select role_is_leader_plus(auth.uid()); $$;
create or replace function public.is_board_approver() returns boolean
language sql stable security definer set search_path = public as $$ select role_is_board_approver(auth.uid()); $$;
create or replace function public.is_org_wide() returns boolean
language sql stable security definer set search_path = public as $$ select role_is_org_wide(auth.uid()); $$;
create or replace function public.acts_as_is(p_pos text) returns boolean
language sql stable security definer set search_path = public as $$ select coalesce(role_acts_as(auth.uid()) = p_pos, false); $$;

-- 既存ヘルパーは**契約を変えずに中身だけ**差し替える（呼んでいるポリシー8本は触らない）
create or replace function public.is_leader() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from profiles p where p.id = auth.uid() and p.is_active = true and role_acts_as(p.id) = 'leader');
$$;
create or replace function public.is_manager_plus() returns boolean
language sql stable security definer set search_path = public as $$
  select is_admin() or exists (select 1 from profiles p where p.id = auth.uid() and p.is_active = true and role_is_manager_plus(p.id));
$$;

-- ========================================
-- 3) 序列（残業サマリーの閲覧範囲）。値は変わるが上下の関係は保つ
--    🚨 Q3b（2026-09-09 ユーザー確定）：社長と管理者の同点をやめる（管理者＞社長）。
--       社長から経理の残業集計は見えなくなる
-- ========================================
create or replace function public.overtime_role_rank(p_uid uuid) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(role_rank(p_uid), 99);
$$;
create or replace function public.overtime_role_rank_target(p_uid uuid) returns integer
language sql stable security definer set search_path = public as $$
  select coalesce(role_rank(p_uid), 1);
$$;

-- ========================================
-- 4) 役職名を直書きしていた関数の中身（本番の実定義から、該当行だけ差し替え）
-- ========================================
-- 安否確認の緊急通知：マネージャー以上（管理者を含む）
create or replace function public.notify_safety_urgent(p_check_id uuid, p_target_user_id uuid)
 returns void language plpgsql security definer set search_path to 'public' as $function$
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
         and role_is_manager_plus(p.id)
    ) x
    where x.id is not null and x.id <> p_target_user_id
  loop
    insert into notifications (user_id, message, sub_message, source_type, reference_id, event_key, read)
    values (r.id,
            coalesce(v_name, 'スタッフ') || 'さんが助けを必要としています',
            v_title,
            'safety_check_urgent', p_check_id::text, 'safety:urgent', false);
  end loop;
end;
$function$;

-- 備品購入の進捗：決裁者（管理者を含まない）
create or replace function public.purchase_request_approval_progress(p_ids uuid[])
 returns table(purchase_request_id uuid, answered integer, required integer, pending_ids uuid[], answers jsonb)
 language sql stable security definer set search_path to 'public' as $function$
  WITH me AS (
    SELECT
      auth.uid() AS uid,
      ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin') AS is_admin,
      role_is_board_approver(auth.uid()) AS is_board
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
      OR me.is_board
      OR me.uid = ANY(COALESCE(r.board_approver_ids, '{}'::uuid[]))
      OR me.uid = ANY(COALESCE(r.requested_manager_ids, '{}'::uuid[]))
    ) AS can_see_names
  ) vis
  WHERE r.id = ANY(p_ids)
    AND (
      r.user_id = me.uid
      OR me.uid = ANY(COALESCE(r.board_approver_ids, '{}'::uuid[]))
      OR me.uid = ANY(COALESCE(r.requested_manager_ids, '{}'::uuid[]))
      OR me.is_board
      OR me.is_admin
    );
$function$;

-- 3万円超の全員承認の決裁者を自動で入れるトリガー：決裁者（🚨 管理者＝経理を含まない）
create or replace function public.set_board_approver_ids()
 returns trigger language plpgsql as $function$
BEGIN
  IF NEW.amount > 30000 AND NEW.request_type = 'purchase_request' AND NOT NEW.president_self_judgment THEN
    IF TG_OP = 'INSERT' OR NEW.board_approver_ids IS NOT DISTINCT FROM OLD.board_approver_ids THEN
      SELECT array_agg(p.id) INTO NEW.board_approver_ids
        FROM public.profiles p
        WHERE p.is_active = true
          AND role_is_board_approver(p.id)
          AND p.id != NEW.user_id;
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- 休暇申請フォームの送信許可：リーダー以上
create or replace function public.set_leave_request_enabled(p_user_id uuid, p_enabled boolean)
 returns void language plpgsql security definer set search_path to 'public' as $function$
begin
  if not (is_admin() or role_is_leader_plus(auth.uid())) then
    raise exception '休暇申請フォームを送る権限がありません';
  end if;

  update profiles
     set leave_request_enabled = p_enabled,
         leave_enabled_by = case when p_enabled then auth.uid() else null end
   where id = p_user_id;
end $function$;

-- シフト調整の状態変更：feature_permissions を名前ではなく role_id で引く（段0で role_id が信頼できるようになった）
create or replace function public.set_leave_shift_adjust(p_id uuid, p_status text)
 returns table(ok boolean, reason text) language plpgsql security definer set search_path to 'public' as $function$
declare
  v_role_id uuid;
  v_is_admin boolean;
  v_count int;
begin
  if p_status not in ('pending', 'adjusted', 'no_change') then
    return query select false, '状態の値が正しくありません'::text;
    return;
  end if;

  v_is_admin := coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
  select role_id into v_role_id from profiles where id = auth.uid();

  if not (v_is_admin or exists (
        select 1
          from feature_permissions fp
         where fp.feature_key = 'leave_shift_adjust'
           and fp.enabled
           and fp.role_id = v_role_id)) then
    return query select false, 'シフト調整の状態を変える権限がありません（管理画面の「役職・機能権限」で設定します）'::text;
    return;
  end if;

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
end $function$;

-- 通知の宛先解決：役職名でも role_id でも受け付ける（段5で JSON を role_id に変換するまでの両対応）。
-- 既定値は属性から出す（立場 leader/manager/president ＝ 宛先の既定、経営 ＝ 絞り込みの対象外の既定）。
-- 🚨 これで「会長」を president に立てれば、設定を触らずに社長宛に入る（Q4=A）
create or replace function public.resolve_role_recipients(p_applicant uuid, p_recipient jsonb)
 returns setof uuid language plpgsql stable security definer set search_path to 'public' as $function$
declare
  v_roles_raw    text[];
  v_owide_raw    text[];
  v_roles        uuid[];
  v_org_wide     uuid[];
  v_group_roles  uuid[];
  v_owide_roles  uuid[];
  v_group_filter text;
  v_teams        text[];
begin
  v_group_filter := coalesce(p_recipient ->> 'groupFilter', 'all');

  -- 宛先の役職。指定が無ければ立場 leader/manager/president の役職すべて
  if p_recipient ? 'roles' then
    v_roles_raw := coalesce((select array_agg(x) from jsonb_array_elements_text(p_recipient -> 'roles') x), '{}');
    v_roles := array(select r.id from roles r
                      where r.name = any(v_roles_raw) or r.id::text = any(v_roles_raw));
  else
    v_roles := array(select r.id from roles r where r.acts_as in ('leader', 'manager', 'president'));
  end if;

  -- 絞り込みの対象外。指定が無ければ「経営」の役職すべて
  if p_recipient ? 'orgWideRoles' then
    v_owide_raw := coalesce((select array_agg(x) from jsonb_array_elements_text(p_recipient -> 'orgWideRoles') x), '{}');
    v_org_wide := array(select r.id from roles r
                         where r.name = any(v_owide_raw) or r.id::text = any(v_owide_raw));
  else
    v_org_wide := array(select r.id from roles r where r.is_org_wide);
  end if;

  v_group_roles := array(select unnest(v_roles) except select unnest(v_org_wide));
  v_owide_roles := array(select unnest(v_roles) intersect select unnest(v_org_wide));

  select coalesce(array_agg(g), '{}')
    into v_teams
    from unnest(coalesce((select group_names from profiles where id = p_applicant), '{}')) g
   where g in (select value from master_options where category = 'shift_report_group');

  if not exists (select 1 from master_options where category = 'shift_report_group') then
    v_teams := coalesce((select group_names from profiles where id = p_applicant), '{}');
  end if;

  return query
    select p.id from profiles p
     where p.is_active = true
       and p.role_id = any(v_group_roles)
       and (v_group_filter <> 'same' or cardinality(v_teams) = 0 or p.group_names && v_teams)
       and p.id <> p_applicant
    union
    select p.id from profiles p
     where p.is_active = true
       and p.role_id = any(v_owide_roles)
       and p.id <> p_applicant;
end $function$;

-- ========================================
-- 5) 役職名を直書きしていたRLSポリシー14本。名前・対象コマンド・対象ロールは元のまま、役職の条件だけ差し替え
-- ========================================
-- 社内お知らせの書き込み：役職名「管理者」→ システム管理者（Q5=B）
drop policy if exists "announcements_admin_write" on public.announcements;
create policy "announcements_admin_write" on public.announcements
  for all to authenticated using (is_admin()) with check (is_admin());

-- 勤怠カレンダーへの登録・取消：役職ではなく、管理画面「権限管理」のトグル（attendance_input）で決める
-- （2026-09-09 ユーザー決定）。画面の入力ボタンも同じトグルを読むので、画面とDBの顔ぶれが食い違わない。
-- 🚨 これまでは画面＝承認者（フロア責任者込み）／DB＝リーダー以上（フロア責任者なし）で食い違っていた。
--    初期値はいまのDBの動きを再現（リーダー・マネージャー・社長・管理者 ON）。
insert into public.feature_permissions (role_id, feature_key, enabled)
select r.id, 'attendance_input', (r.name in ('リーダー', 'マネージャー', '社長', '管理者'))
  from public.roles r
on conflict (role_id, feature_key) do nothing;

drop policy if exists "Approvers can manage attendance_exceptions" on public.attendance_exceptions;
create policy "Approvers can manage attendance_exceptions" on public.attendance_exceptions
  for all to authenticated using (is_admin() or has_feature_permission('attendance_input'));

-- 休暇申請の代理登録：経営（管理者・社長）
drop policy if exists "admin_insert_leave_requests" on public.leave_requests;
create policy "admin_insert_leave_requests" on public.leave_requests
  for insert to authenticated with check (is_org_wide());

-- 休暇申請の閲覧（承認者経路）：社長 → 立場 president
drop policy if exists "approvers_can_read_leave_requests" on public.leave_requests;
create policy "approvers_can_read_leave_requests" on public.leave_requests
  for select to authenticated
  using (user_id = auth.uid() or approver_id = auth.uid() or approver2_id = auth.uid() or is_admin() or acts_as_is('president'));

-- 休暇申請の全件閲覧・更新：リーダー以上
drop policy if exists "select_admin" on public.leave_requests;
create policy "select_admin" on public.leave_requests
  for select to authenticated using (is_admin() or is_leader_plus());
drop policy if exists "update_admin" on public.leave_requests;
create policy "update_admin" on public.leave_requests
  for update using (is_leader_plus());

-- 通知設定の編集：経営（管理者・社長）
drop policy if exists "管理者のみ編集可能" on public.notification_settings;
create policy "管理者のみ編集可能" on public.notification_settings
  for all using (is_org_wide()) with check (is_org_wide());

-- 備品購入の意見・本体・領収書ログ：決裁者（管理者を含まない）
drop policy if exists "opinion_select" on public.purchase_request_manager_opinions;
create policy "opinion_select" on public.purchase_request_manager_opinions
  for select using (
    exists (select 1 from purchase_requests pr
             where pr.id = purchase_request_manager_opinions.purchase_request_id
               and (auth.uid() = any(pr.requested_manager_ids) or auth.uid() = any(pr.board_approver_ids)))
    or is_board_approver()
    or (visible_to_applicant and exists (select 1 from purchase_requests pr
                                          where pr.id = purchase_request_manager_opinions.purchase_request_id
                                            and pr.user_id = auth.uid()))
  );
drop policy if exists "pr_manager_plus_select" on public.purchase_requests;
create policy "pr_manager_plus_select" on public.purchase_requests
  for select using (is_admin() or is_board_approver());
drop policy if exists "receipt_download_log_select" on public.receipt_download_log;
create policy "receipt_download_log_select" on public.receipt_download_log
  for select using (
    is_admin() or is_board_approver()
    or exists (select 1 from purchase_requests pr where pr.id = receipt_download_log.purchase_request_id and pr.user_id = auth.uid())
  );

-- 勤務変更報告とその履歴：承認者（フロア責任者を含む）
drop policy if exists "history_select" on public.shift_report_history;
create policy "history_select" on public.shift_report_history
  for select to authenticated using (changed_by = auth.uid() or is_admin() or is_approver());
drop policy if exists "approver_delete" on public.shift_reports;
create policy "approver_delete" on public.shift_reports
  for delete to authenticated using (is_admin() or is_approver());
drop policy if exists "approver_select" on public.shift_reports;
create policy "approver_select" on public.shift_reports
  for select to authenticated using (is_admin() or is_approver());
drop policy if exists "reviewer_confirm" on public.shift_reports;
create policy "reviewer_confirm" on public.shift_reports
  for update to authenticated using (reviewer_id = auth.uid() and (is_admin() or is_approver()));
