-- ========================================
-- 安否確認機能 Phase 2：RPC群
--   本人回答 / 代行回答 / 終了 / 誤発信の取消
--   発信そのもの（checks/recipients の作成・強制通知の送信）は
--   Edge Function（safety-check-send・service_role）が行う。
-- ========================================

-- 本人回答（常に最優先。代行行も自分の旧回答も上書きする）
create or replace function submit_safety_response(
  p_check_id uuid,
  p_choice text,
  p_comment text default null,
  p_client_key text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recipients_count int;
  v_responses_count int;
  v_created_by uuid;
  v_title text;
begin
  if not is_safety_recipient(p_check_id) then
    raise exception 'permission denied: not a recipient' using errcode = '42501';
  end if;
  if not exists (select 1 from safety_checks where id = p_check_id) then
    raise exception 'safety_check not found' using errcode = 'P0002';
  end if;
  if coalesce(btrim(p_choice), '') = '' then
    raise exception 'choice required' using errcode = '22023';
  end if;

  insert into safety_check_responses (check_id, user_id, choice, comment, is_proxy, proxy_by, client_key)
  values (p_check_id, auth.uid(), p_choice, nullif(btrim(coalesce(p_comment,'')),''), false, null, p_client_key)
  on conflict (check_id, user_id) do update
    set choice = excluded.choice, comment = excluded.comment,
        is_proxy = false, proxy_by = null, answered_at = now(), client_key = excluded.client_key;

  insert into safety_check_response_log (check_id, user_id, choice, comment, is_proxy, proxy_by, client_key)
  values (p_check_id, auth.uid(), p_choice, nullif(btrim(coalesce(p_comment,'')),''), false, null, p_client_key);

  -- 全員回答が揃ったら発信者へ一度だけ通知（原子的に判定。FOR UPDATE + aggregate は使わない）
  select count(*) into v_recipients_count from safety_check_recipients where check_id = p_check_id;
  select count(*) into v_responses_count from safety_check_responses where check_id = p_check_id;

  if v_responses_count >= v_recipients_count then
    update safety_checks set all_answered_at = now()
     where id = p_check_id and all_answered_at is null and status = 'active'
    returning created_by, title into v_created_by, v_title;

    if v_created_by is not null then
      insert into notifications (user_id, message, sub_message, source_type, reference_id, event_key, read)
      values (v_created_by, '全員の回答が揃いました', v_title, 'safety_check', p_check_id::text, null, false);
    end if;
  end if;
end;
$$;

grant execute on function submit_safety_response(uuid, text, text, text) to authenticated;


-- 代行回答（マネージャー以上、または進行中のリーダーのみ。本人回答があれば上書きしない）
create or replace function submit_safety_response_proxy(
  p_check_id uuid,
  p_target_user_id uuid,
  p_choice text,
  p_comment text default null
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not (is_manager_plus() or (is_leader() and safety_check_is_active(p_check_id))) then
    raise exception 'permission denied' using errcode = '42501';
  end if;
  if not exists (select 1 from safety_check_recipients where check_id = p_check_id and user_id = p_target_user_id) then
    raise exception 'target is not a recipient of this check' using errcode = 'P0002';
  end if;
  if coalesce(btrim(p_choice), '') = '' then
    raise exception 'choice required' using errcode = '22023';
  end if;

  insert into safety_check_responses (check_id, user_id, choice, comment, is_proxy, proxy_by)
  values (p_check_id, p_target_user_id, p_choice, nullif(btrim(coalesce(p_comment,'')),''), true, auth.uid())
  on conflict (check_id, user_id) do update
    set choice = excluded.choice, comment = excluded.comment,
        proxy_by = excluded.proxy_by, answered_at = now()
    where safety_check_responses.is_proxy = true;   -- ★本人回答（is_proxy=false）は代行で上書きできない

  insert into safety_check_response_log (check_id, user_id, choice, comment, is_proxy, proxy_by)
  values (p_check_id, p_target_user_id, p_choice, nullif(btrim(coalesce(p_comment,'')),''), true, auth.uid());
end;
$$;

grant execute on function submit_safety_response_proxy(uuid, uuid, text, text) to authenticated;


-- 終了（マネージャー以上）。終了後もsubmit_safety_responseは受け付ける（statusチェックしていないため）
create or replace function close_safety_check(p_check_id uuid) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_manager_plus() then
    raise exception 'permission denied: manager or above only' using errcode = '42501';
  end if;
  update safety_checks set status = 'closed', closed_by = auth.uid(), closed_at = now(), next_remind_at = null
   where id = p_check_id and status = 'active';
  if not found then
    raise exception 'safety_check not found or already closed' using errcode = 'P0002';
  end if;
end;
$$;

grant execute on function close_safety_check(uuid) to authenticated;


-- 誤発信の取消（マネージャー以上）。全員のバナー・バッジが即座に消える。回答済みデータは保持（集計には出さない運用はUI側）
create or replace function cancel_safety_check(p_check_id uuid) returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_title text;
  r record;
begin
  if not is_manager_plus() then
    raise exception 'permission denied: manager or above only' using errcode = '42501';
  end if;
  update safety_checks set status = 'closed', cancelled = true, cancelled_at = now(),
    closed_by = auth.uid(), closed_at = now(), next_remind_at = null
   where id = p_check_id and cancelled = false
  returning title into v_title;
  if v_title is null then
    raise exception 'safety_check not found or already cancelled' using errcode = 'P0002';
  end if;

  -- 宛先全員に「誤送信でした」の通常ベル通知（安全のためのfor文。数十件規模なので問題なし）
  for r in select user_id from safety_check_recipients where check_id = p_check_id loop
    insert into notifications (user_id, message, sub_message, source_type, reference_id, event_key, read)
    values (r.user_id, '先ほどの安否確認は誤送信でした', v_title, 'safety_check_cancelled', p_check_id::text, null, false);
  end loop;
end;
$$;

grant execute on function cancel_safety_check(uuid) to authenticated;
