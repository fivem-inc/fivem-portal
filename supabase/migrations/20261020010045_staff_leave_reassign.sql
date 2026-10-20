-- ============================================================
-- 2026-10-20  休職（段3の2：受理待ちの一覧と付け替え）
-- 計画：docs/計画-休職と手続き.md
-- ============================================================
-- ・staff_pending_items(p_user)：その人が対応する予定の申請（受理待ち）の一覧。マネージャー以上と管理者だけ。
--   決め方は退職の付け替え（retire_apply）と同じ：
--     残業＝reviewer_id かつ 確定・取消以外／勤務変更＝reviewer_id かつ pending／
--     休暇＝1人目 approver_id かつ pending・2人目 approver2_id かつ pending か manager_approved／
--     備品＝pending_leader の leader_id・pending_manager の requested_manager_ids・pending_board の board_approver_ids（付け替えはここではしない＝申請の画面の［承認者を変更］）
-- ・staff_leave_reassign(p_user, p_items)：1件ずつ付け替える（管理者だけ）。付け替え先は在籍・休職中でない人。
--   付け替えたら、新しい受理者へ「受理待ち」のベル（<種類>:pending_approval）、申請者へ「結果」のベル（<種類>）。
--   🚨 ベルの文に休職の言葉・理由は出さない（UI/UX レビュー）。event_key は付けない（スマホには出さない）
-- ・記録 staff_leave_reassignments（だれの・どの申請を・だれからだれへ）。読めるのはマネージャー以上と管理者
--
-- ロールバック手順:
--   drop function if exists staff_leave_reassign(uuid, jsonb), staff_pending_items(uuid);
--   drop table if exists staff_leave_reassignments;

create table if not exists public.staff_leave_reassignments (
  id           uuid primary key default gen_random_uuid(),
  leave_user_id uuid references public.profiles(id) on delete set null, -- 休職する（していた）人＝もとの受理者
  table_name   text not null,
  row_id       uuid not null,
  column_name  text not null,
  to_user_id   uuid references public.profiles(id) on delete set null,
  done_by      uuid references public.profiles(id) on delete set null,
  done_at      timestamptz not null default now()
);
comment on table public.staff_leave_reassignments is '休職のときの受理待ちの付け替えの記録（2026-10-20）';
alter table public.staff_leave_reassignments enable row level security;
revoke all on public.staff_leave_reassignments from anon;
revoke insert, update, delete, truncate on public.staff_leave_reassignments from authenticated;
drop policy if exists staff_leave_reassignments_select on public.staff_leave_reassignments;
create policy staff_leave_reassignments_select on public.staff_leave_reassignments
  for select to authenticated using (is_manager_plus());

-- 受理待ちの一覧
create or replace function public.staff_pending_items(p_user uuid)
returns table (kind text, row_id uuid, col text, applicant_id uuid, applicant_name text, item_date date, detail text, can_reassign boolean)
language plpgsql stable security definer set search_path to 'public'
as $$
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
     where s.reviewer_id = p_user and s.status = 'pending'
    union all
    select 'purchase', r.id, ''::text, r.user_id, p.name, r.created_at::date, r.item_name, false
      from purchase_requests r left join profiles p on p.id = r.user_id
     where (r.status = 'pending_leader'  and r.leader_id = p_user)
        or (r.status = 'pending_manager' and p_user = any (coalesce(r.requested_manager_ids, '{}')))
        or (r.status = 'pending_board'   and p_user = any (coalesce(r.board_approver_ids, '{}')))
     order by 6, 1;
end;
$$;

-- 付け替え。p_items = [{"kind":"leave|overtime|shift","row_id":"…","col":"approver_id|approver2_id|reviewer_id","to":"…"}, …]
create or replace function public.staff_leave_reassign(p_user uuid, p_items jsonb)
returns integer
language plpgsql security definer set search_path to 'public'
as $$
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
       where id = v_row and reviewer_id = p_user and status = 'pending'
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
$$;

revoke execute on function public.staff_pending_items(uuid) from public, anon;
revoke execute on function public.staff_leave_reassign(uuid, jsonb) from public, anon;
grant execute on function public.staff_pending_items(uuid) to authenticated;
grant execute on function public.staff_leave_reassign(uuid, jsonb) to authenticated;
