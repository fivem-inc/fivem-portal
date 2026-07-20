-- ========================================
-- 修正依頼の RPC 3本（すべて SECURITY DEFINER・1トランザクション）
--   submit_correction_request  : 本人が依頼を出す（所有チェック＋管理者へベル通知fan-out）
--   resolve_correction_request : 管理者が対応済みにする（本人へ通知）
--   decline_correction_request : 管理者が対応不可にする（理由必須・本人へ通知）
-- Slack通知はクライアントから既存Edge Function経由（DBからHTTPは投げない＝既存パターン踏襲）。
-- ベル通知はRPC内（欠落が痛いので本体と同一トランザクション）。
-- ========================================

-- 本人が修正依頼を出す。target_id が本当に本人の申請かを RPC 内で検証（クライアントの target_type を信用しない）。
create or replace function submit_correction_request(
  p_target_type text,
  p_target_id uuid,
  p_message text,
  p_requested_changes jsonb default null,
  p_request_kind text default 'edit'
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_owner uuid;
  v_admin_id uuid;
  v_requester_name text;
  v_kind_label text;
begin
  if p_target_type not in ('leave','shift','overtime') then
    raise exception 'invalid target_type: %', p_target_type using errcode = '22023';
  end if;
  if p_request_kind not in ('edit','cancel') then
    raise exception 'invalid request_kind: %', p_request_kind using errcode = '22023';
  end if;
  if coalesce(btrim(p_message), '') = '' then
    raise exception 'message required' using errcode = '22023';
  end if;

  -- 所有チェック（target_typeごとに参照先テーブル・所有者列を切り替え）
  v_owner := case p_target_type
    when 'leave'    then (select user_id      from leave_requests   where id = p_target_id)
    when 'shift'    then (select applicant_id from shift_reports    where id = p_target_id)
    when 'overtime' then (select applicant_id from overtime_reports where id = p_target_id)
  end;
  if v_owner is null then
    raise exception 'target not found' using errcode = 'P0002';
  end if;
  if v_owner <> auth.uid() then
    raise exception 'permission denied: not owner' using errcode = '42501';
  end if;

  -- 二重open防止（部分ユニークindexが本命。ここは友好的メッセージのための先行チェック）
  if exists (
    select 1 from correction_requests
    where target_type = p_target_type and target_id = p_target_id and status = 'open'
  ) then
    raise exception 'この申請には対応待ちの依頼が既にあります' using errcode = '23505';
  end if;

  insert into correction_requests (target_type, target_id, requester_id, message, requested_changes, request_kind)
  values (p_target_type, p_target_id, auth.uid(), btrim(p_message), p_requested_changes, p_request_kind)
  returning id into v_id;

  -- 依頼者名（通知本文用）
  select coalesce(p.name, p.email, 'スタッフ') into v_requester_name
  from profiles p where p.id = auth.uid();

  v_kind_label := case when p_request_kind = 'cancel' then '取消依頼' else '修正依頼' end;

  -- 管理者全員へベル通知（app_metadata.role='admin' が唯一の判定）
  for v_admin_id in
    select u.id from auth.users u where u.raw_app_meta_data ->> 'role' = 'admin'
  loop
    insert into notifications (user_id, message, sub_message, source_type, reference_id, event_key, read)
    values (
      v_admin_id,
      v_kind_label || 'が届きました',
      coalesce(v_requester_name, 'スタッフ') || '：' || left(btrim(p_message), 120),
      'correction_request', v_id, 'correction:new', false
    );
  end loop;

  return v_id;
end;
$$;

grant execute on function submit_correction_request(text, uuid, text, jsonb, text) to authenticated;


-- 本人が自分の未対応(open)依頼を取り下げる。open が1件までのため、種別を変えて出し直したいとき等に使う。
create or replace function withdraw_correction_request(p_id uuid) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update correction_requests set status = 'withdrawn'
  where id = p_id and requester_id = auth.uid() and status = 'open';
  if not found then
    raise exception '取り下げできません（対象が見つからないか、既に対応済みです）' using errcode = 'P0002';
  end if;
end;
$$;

grant execute on function withdraw_correction_request(uuid) to authenticated;


-- 管理者が「対応済み」にする。修正の反映（admin_edit_*）は別途モーダルで行い、成功後にこれを呼ぶ。
create or replace function resolve_correction_request(
  p_id uuid,
  p_admin_reply text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_requester uuid;
begin
  if not is_admin() then
    raise exception 'permission denied: admin only' using errcode = '42501';
  end if;

  update correction_requests set
    status      = 'resolved',
    admin_reply = nullif(btrim(coalesce(p_admin_reply, '')), ''),
    resolved_by = auth.uid(),
    resolved_at = now()
  where id = p_id and status = 'open'
  returning requester_id into v_requester;

  if v_requester is null then
    raise exception 'correction_request not found or not open: %', p_id using errcode = 'P0002';
  end if;

  insert into notifications (user_id, message, sub_message, source_type, reference_id, event_key, read)
  values (
    v_requester,
    '修正依頼に対応しました',
    coalesce(nullif(btrim(coalesce(p_admin_reply, '')), ''), '内容を確認し対応しました'),
    'correction_request', p_id, 'correction:resolved', false
  );
end;
$$;

grant execute on function resolve_correction_request(uuid, text) to authenticated;


-- 管理者が「対応不可」にする（理由必須）。本人へ理由つきで通知。
create or replace function decline_correction_request(
  p_id uuid,
  p_reason text
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_requester uuid;
begin
  if not is_admin() then
    raise exception 'permission denied: admin only' using errcode = '42501';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'reason required' using errcode = '22023';
  end if;

  update correction_requests set
    status      = 'declined',
    admin_reply = btrim(p_reason),
    resolved_by = auth.uid(),
    resolved_at = now()
  where id = p_id and status = 'open'
  returning requester_id into v_requester;

  if v_requester is null then
    raise exception 'correction_request not found or not open: %', p_id using errcode = 'P0002';
  end if;

  insert into notifications (user_id, message, sub_message, source_type, reference_id, event_key, read)
  values (
    v_requester,
    '修正依頼にお返事があります',
    btrim(p_reason),
    'correction_request', p_id, 'correction:declined', false
  );
end;
$$;

grant execute on function decline_correction_request(uuid, text) to authenticated;
