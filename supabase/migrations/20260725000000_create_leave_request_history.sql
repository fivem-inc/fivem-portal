-- 休暇申請の「管理者修正」差分履歴を記録するテーブル ＋ 原子的更新RPC
-- 勤務変更(shift_report_history)・残業(overtime_report_history)と履歴スキーマを揃える。
-- change_kind でバッジ種別を区別： admin_edit=管理者が修正 / resubmit=本人が再申請 / rejected=差し戻し / approved=受理 / cancelled=取消
create table if not exists leave_request_history (
  id uuid primary key default gen_random_uuid(),
  leave_request_id uuid not null references leave_requests(id) on delete cascade,
  change_kind text not null default 'admin_edit'
    check (change_kind in ('admin_edit','resubmit','rejected','approved','cancelled','type_change')),
  change_summary text,          -- 表示用の短い要約（例：「日付・校を修正」）
  change_reason text,           -- 管理者が入力した修正理由（本人へ通知される）
  changes jsonb,                -- { フィールド名: { old: ..., new: ... } } 表示用の差分
  snapshot jsonb,               -- 変更前の全体スナップショット（完全復元・監査用）
  changed_by uuid references auth.users(id),
  changed_at timestamptz not null default now()
);

alter table leave_request_history enable row level security;

-- 管理者は全履歴を閲覧可（★RLSの管理者判定は必ず app_metadata->>'role'。旧 (auth.jwt()->>'role') は 'authenticated' が返り42501で全滅する）
create policy "leave_request_history_admin_select" on leave_request_history
  for select using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');
-- 申請者は自分の申請に紐づく履歴を閲覧可（本人が「管理者に修正された」ことを確認できるように）
create policy "leave_request_history_owner_select" on leave_request_history
  for select using (
    exists (
      select 1 from leave_requests lr
      where lr.id = leave_request_id and lr.user_id = auth.uid()
    )
  );

create index if not exists leave_request_history_req_idx
  on leave_request_history (leave_request_id, changed_at desc);

-- 管理者が休暇申請の内容を直接修正する。本体更新と履歴記録を1トランザクションで行い、履歴の欠落を防ぐ。
-- SECURITY DEFINER：RLSを跨いで確実に update+insert するが、先頭で管理者判定して権限を担保する。
create or replace function admin_edit_leave_request(
  p_id uuid,
  p_leave_type text,
  p_leave_type_other text,
  p_leave_dates text,
  p_leave_locations text,
  p_purpose text,
  p_reason text,
  p_start_date date,
  p_end_date date,
  p_changes jsonb,
  p_change_summary text,
  p_change_reason text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_snapshot jsonb;
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') <> 'admin' then
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
$$;

grant execute on function admin_edit_leave_request(
  uuid, text, text, text, text, text, text, date, date, jsonb, text, text
) to authenticated;
