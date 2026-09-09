-- 修正依頼と取消依頼で、通知の event_key を分ける。
--
-- 背景（2026-09-09 ユーザー確定）:
--   correction_requests は request_kind で「修正依頼(edit)」と「取消依頼(cancel)」の
--   2種類を扱っているのに、通知の event_key は 'correction:new' の1つだけだった。
--   そのためプッシュのアプリ名が両方とも「修正」になり、
--   ベルには「取消依頼が届きました」と出るのにスマホには「修正」と出る食い違いがあった。
--
-- 変更後の event_key（6つ）:
--   correction:new_edit        / correction:new_cancel        管理者へ（要対応）
--   correction:resolved_edit   / correction:resolved_cancel   本人へ（対応済み）
--   correction:declined_edit   / correction:declined_cancel   本人へ（見送り）
--
-- 🚨 旧キー（correction:new / resolved / declined）は消さない。
--   すでに作られた通知が持っているため、消すとベルの分類が壊れる。
--   画面側（App.tsx）は startsWith で新旧どちらも拾うようにしてある。
--
-- 🚨 この4つの定義は、リポジトリのファイルではなく
--   **本番の pg_get_functiondef から起こした**（古い版で上書きする事故を避けるため）。
--   変更したのは event_key を決める部分だけで、権限チェック・更新処理・例外は元のまま。

-- ========================================
-- 1) 依頼を出す（本人 → 管理者全員へ）
-- ========================================
create or replace function public.submit_correction_request(
  p_target_type text,
  p_target_id uuid,
  p_message text,
  p_requested_changes jsonb default null::jsonb,
  p_request_kind text default 'edit'::text
) returns uuid
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_id uuid; v_owner uuid; v_admin_id uuid; v_requester_name text; v_kind_label text;
  v_event_key text;
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

  -- 🚨 2026-09-09 追加。ログインしていない状態（auth.uid() が null）を先に弾く。
  --    これが無いと、下の所有者チェックが「v_owner <> null」＝ null となって成立せず、
  --    そのまま insert まで進んでしまう（実際に anon でなりすまして確認した。
  --    止まっていたのは requester_id の not-null 制約のおかげで、チェックが働いた結果ではない）。
  if auth.uid() is null then
    raise exception 'permission denied: not signed in' using errcode = '42501';
  end if;

  v_owner := case p_target_type
    when 'leave'    then (select user_id      from leave_requests   where id = p_target_id)
    when 'shift'    then (select applicant_id from shift_reports    where id = p_target_id)
    when 'overtime' then (select applicant_id from overtime_reports where id = p_target_id)
  end;
  if v_owner is null then raise exception 'target not found' using errcode = 'P0002'; end if;
  -- 🚨 <> ではなく is distinct from を使う（どちらかが null でも必ず true/false になる）
  if v_owner is distinct from auth.uid() then raise exception 'permission denied: not owner' using errcode = '42501'; end if;

  if exists (select 1 from correction_requests
             where target_type = p_target_type and target_id = p_target_id and status = 'open') then
    raise exception 'この申請には対応待ちの依頼が既にあります' using errcode = '23505';
  end if;

  insert into correction_requests (target_type, target_id, requester_id, message, requested_changes, request_kind)
  values (p_target_type, p_target_id, auth.uid(), btrim(p_message), p_requested_changes, p_request_kind)
  returning id into v_id;

  select coalesce(p.name, p.email, 'スタッフ') into v_requester_name from profiles p where p.id = auth.uid();
  v_kind_label := case when p_request_kind = 'cancel' then '取消依頼' else '修正依頼' end;
  v_event_key  := case when p_request_kind = 'cancel' then 'correction:new_cancel' else 'correction:new_edit' end;

  for v_admin_id in select u.id from auth.users u where u.raw_app_meta_data ->> 'role' = 'admin'
  loop
    insert into notifications (user_id, message, sub_message, source_type, reference_id, event_key, read)
    values (v_admin_id, v_kind_label || 'が届きました',
            coalesce(v_requester_name, 'スタッフ') || '：' || left(btrim(p_message), 120),
            'correction_request', v_id, v_event_key, false);
  end loop;
  return v_id;
end;
$function$;

-- ========================================
-- 2) 管理者が対応済みにする（→ 本人へ）
-- ========================================
create or replace function public.resolve_correction_request(
  p_id uuid,
  p_admin_reply text default null::text
) returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_requester uuid; v_kind text; v_event_key text; v_label text;
begin
  -- 🚨 coalesce で包む。is_admin() が null を返すと not null = null となり、if が成立せず素通りする
  if not coalesce(is_admin(), false) then raise exception 'permission denied: admin only' using errcode = '42501'; end if;
  -- 種類は更新の前に読む（更新後でも変わらないが、1回の select で済ませる）
  select request_kind into v_kind from correction_requests where id = p_id;
  update correction_requests set
    status = 'resolved', admin_reply = nullif(btrim(coalesce(p_admin_reply, '')), ''),
    resolved_by = auth.uid(), resolved_at = now()
  where id = p_id and status = 'open' returning requester_id into v_requester;
  if v_requester is null then raise exception 'not found or not open' using errcode = 'P0002'; end if;
  v_label     := case when v_kind = 'cancel' then '取消依頼' else '修正依頼' end;
  v_event_key := case when v_kind = 'cancel' then 'correction:resolved_cancel' else 'correction:resolved_edit' end;
  insert into notifications (user_id, message, sub_message, source_type, reference_id, event_key, read)
  values (v_requester, v_label || 'に対応しました',
          coalesce(nullif(btrim(coalesce(p_admin_reply, '')), ''), '内容を確認し対応しました'),
          'correction_request', p_id, v_event_key, false);
end;
$function$;

-- ========================================
-- 3) 管理者が見送る（→ 本人へ・理由必須）
-- ========================================
create or replace function public.decline_correction_request(
  p_id uuid,
  p_reason text
) returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_requester uuid; v_kind text; v_event_key text; v_label text;
begin
  -- 🚨 coalesce で包む。is_admin() が null を返すと not null = null となり、if が成立せず素通りする
  if not coalesce(is_admin(), false) then raise exception 'permission denied: admin only' using errcode = '42501'; end if;
  if coalesce(btrim(p_reason), '') = '' then raise exception 'reason required' using errcode = '22023'; end if;
  select request_kind into v_kind from correction_requests where id = p_id;
  update correction_requests set
    status = 'declined', admin_reply = btrim(p_reason), resolved_by = auth.uid(), resolved_at = now()
  where id = p_id and status = 'open' returning requester_id into v_requester;
  if v_requester is null then raise exception 'not found or not open' using errcode = 'P0002'; end if;
  v_label     := case when v_kind = 'cancel' then '取消依頼' else '修正依頼' end;
  v_event_key := case when v_kind = 'cancel' then 'correction:declined_cancel' else 'correction:declined_edit' end;
  insert into notifications (user_id, message, sub_message, source_type, reference_id, event_key, read)
  values (v_requester, v_label || 'にお返事があります', btrim(p_reason),
          'correction_request', p_id, v_event_key, false);
end;
$function$;

-- ========================================
-- 4) 対象の申請が取り消されたとき、開いている依頼を自動で閉じる（トリガー）
-- ========================================
create or replace function public.resolve_corrections_on_cancel()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare r record;
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    for r in select id, requester_id, request_kind from correction_requests
             where target_type = tg_argv[0] and target_id = new.id and status = 'open'
    loop
      update correction_requests set status = 'resolved', resolved_at = now(),
        admin_reply = coalesce(admin_reply, '対象の申請が取り消されました') where id = r.id;
      insert into notifications (user_id, message, sub_message, source_type, reference_id, event_key, read)
      values (r.requester_id,
              case when r.request_kind = 'cancel' then '取消依頼' else '修正依頼' end || 'に対応しました',
              '対象の申請を取り消しました',
              'correction_request', r.id,
              case when r.request_kind = 'cancel' then 'correction:resolved_cancel' else 'correction:resolved_edit' end,
              false);
    end loop;
  end if;
  return new;
end;
$function$;

-- ========================================
-- 5) 通知設定を新しいキーにも用意する
--    🚨 行が無いイベントは「ON扱い」で送られ、管理画面からOFFにできない（キルスイッチが無い状態）
-- ========================================
-- 🚨 列名は recipient / subject / template（recipients ではない。取り消しテストで判明）
insert into notification_settings (event_key, channel, enabled, recipient, subject, template)
values
  ('correction:new_edit',        'push', true, null, null, null),
  ('correction:new_cancel',      'push', true, null, null, null),
  ('correction:resolved_edit',   'push', true, null, null, null),
  ('correction:resolved_cancel', 'push', true, null, null, null),
  ('correction:declined_edit',   'push', true, null, null, null),
  ('correction:declined_cancel', 'push', true, null, null, null),
  -- 🚨 これはベルには出ていたのにプッシュの一覧（EVENT_MAP）に無く、
  --    スマホに届いていなかったもの（実データで4件）。同じ日に EVENT_MAP へ足したので、
  --    管理画面からOFFにできるように設定行もここで用意する。
  ('shift:admin_edited',         'push', true, null, null, null)
on conflict (event_key, channel) do nothing;

-- ========================================
-- 6) 🚨 anon（ログインしていない人）の実行権限を外す
-- ========================================
-- 2026-09-09 の実測で、この3本すべてに anon の実行権限が付いたままだと分かった
-- （2026-07-26 の作成時から。Supabase は新しい関数に anon の実行権限を自動で付ける）。
-- このリポジトリは Public で anon キーは client/.env.production に入っている＝誰でも入手できる。
-- 🚨 public と anon の両方から外す（2026-09-09 の取り消しテストで分かったこと）。
--   これまでの記録には「from public では外れないので anon を名指しする」とあったが、
--   実測すると **逆に anon だけ名指ししても外れない**。anon は PUBLIC の一員なので、
--   PUBLIC に権限が残っているかぎり anon も呼べてしまう。両方から外すのが正しい。
-- 🚨 public から外すと authenticated も失うので、そのあとで必ず付け直す。
revoke execute on function public.submit_correction_request(text, uuid, text, jsonb, text) from public;
revoke execute on function public.submit_correction_request(text, uuid, text, jsonb, text) from anon;
grant  execute on function public.submit_correction_request(text, uuid, text, jsonb, text) to authenticated;

revoke execute on function public.resolve_correction_request(uuid, text) from public;
revoke execute on function public.resolve_correction_request(uuid, text) from anon;
grant  execute on function public.resolve_correction_request(uuid, text) to authenticated;

revoke execute on function public.decline_correction_request(uuid, text) from public;
revoke execute on function public.decline_correction_request(uuid, text) from anon;
grant  execute on function public.decline_correction_request(uuid, text) to authenticated;

-- 適用後に必ず実測すること（3つとも false になっているか）：
--   select has_function_privilege('anon','public.submit_correction_request(text,uuid,text,jsonb,text)','execute'),
--          has_function_privilege('anon','public.resolve_correction_request(uuid,text)','execute'),
--          has_function_privilege('anon','public.decline_correction_request(uuid,text)','execute');
