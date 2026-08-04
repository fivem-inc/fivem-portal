-- ========================================
-- 安否確認：「助けが必要」の回答が入った瞬間に知らせる
--
-- これまでは集計画面の最上段に赤枠で出るだけで、誰かが画面を見ていないと
-- 助けを求めている人に気づけなかった（＝いちばん急ぐ情報が受け身だった）。
--
-- 【ユーザー決定】
--   ・宛先＝発信者＋マネージャー以上全員（発信者本人が被災して動けないことがあるため）
--   ・助けを求めた人ごとに毎回知らせる（2人目に気づけないのは本末転倒）
--   ・プッシュ文面は「ファイブM ヘルプ／新着 1件」（2026-08-04 実機テストで
--     Chromeの警告表示に化けないことを確認済み）
--
-- ⚠️ DB側（回答が記録された瞬間）で作るのが要点。
--    オフラインで保存された回答が後から届いたときにも、ちゃんと通知が飛ぶ。
-- ========================================

-- 誰について知らせたかを「人ごと」に持つ。同じ人の再送信で連発しないため。
alter table safety_check_responses add column if not exists urgent_notified_at timestamptz;

-- 選んだ回答が「助けが必要」系か（選択肢の色が red のもの）。
-- 色はパターンごとに発信時スナップショットされた options に入っている。
create or replace function safety_choice_is_urgent(p_check_id uuid, p_choice text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from safety_checks sc, jsonb_array_elements(sc.options) o
    where sc.id = p_check_id and o->>'key' = p_choice and o->>'color' = 'red'
  );
$$;

-- 発信者＋マネージャー以上へベル通知を作る。
-- event_key を入れることで push_queue に積まれ、push-dispatch がプッシュを送る。
-- （安否確認の他の通知は Edge Function が直接プッシュを送るので event_key を null に
--   しているが、これは直送しないので二重にはならない）
create or replace function notify_safety_urgent(p_check_id uuid, p_target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
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
$$;

-- 安否確認を完全削除したとき、この緊急通知も一緒に消す（20260804100000 の更新）
create or replace function delete_safety_check(p_check_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'admin' then
    raise exception 'permission denied' using errcode = '42501';
  end if;

  if not exists (select 1 from safety_checks where id = p_check_id) then
    raise exception 'safety_check not found' using errcode = 'P0002';
  end if;

  delete from notifications
   where source_type in ('safety_check', 'safety_check_cancelled', 'safety_check_urgent')
     and reference_id = p_check_id::text;

  delete from safety_checks where id = p_check_id;
end;
$$;

grant execute on function delete_safety_check(uuid) to authenticated;


-- ---------------- 本人回答（20260804000000 の定義に緊急通知を足したもの） ----------------
drop function if exists submit_safety_response(uuid, text, text, text);

create or replace function submit_safety_response(
  p_check_id uuid,
  p_choice text,
  p_comment text default null,
  p_client_key text default null,
  p_answered_at timestamptz default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recipients_count int;
  v_responses_count int;
  v_created_by uuid;
  v_title text;
  v_answered_at timestamptz;
  v_rows int;
  v_applied boolean;
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

  -- 端末の時計が進んでいると未来の時刻で送られ、あとの回答を全部弾いてしまう。
  v_answered_at := least(coalesce(p_answered_at, now()), now());

  insert into safety_check_responses (check_id, user_id, choice, comment, is_proxy, proxy_by, client_key, answered_at)
  values (p_check_id, auth.uid(), p_choice, nullif(btrim(coalesce(p_comment,'')),''), false, null, p_client_key, v_answered_at)
  on conflict (check_id, user_id) do update
    set choice = excluded.choice, comment = excluded.comment,
        is_proxy = false, proxy_by = null, answered_at = excluded.answered_at, client_key = excluded.client_key
    -- ★すでに記録されている回答の方が新しければ上書きしない（代行入力を守る）
    where safety_check_responses.answered_at <= excluded.answered_at;

  get diagnostics v_rows = row_count;
  v_applied := v_rows > 0;

  insert into safety_check_response_log (check_id, user_id, choice, comment, is_proxy, proxy_by, client_key)
  values (p_check_id, auth.uid(), p_choice, nullif(btrim(coalesce(p_comment,'')),''), false, null, p_client_key);

  -- 「助けが必要」なら即座に知らせる（この人について未通知のときだけ）
  if v_applied and safety_choice_is_urgent(p_check_id, p_choice) then
    update safety_check_responses set urgent_notified_at = now()
     where check_id = p_check_id and user_id = auth.uid() and urgent_notified_at is null;
    if found then
      perform notify_safety_urgent(p_check_id, auth.uid());
    end if;
  elsif v_applied then
    -- 助けが不要な回答に変えたら、次にまた助けを求めたときに知らせられるよう戻す
    update safety_check_responses set urgent_notified_at = null
     where check_id = p_check_id and user_id = auth.uid() and urgent_notified_at is not null;
  end if;

  -- 全員回答が揃ったら発信者へ一度だけ通知
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

  return jsonb_build_object('applied', v_applied);
end;
$$;

grant execute on function submit_safety_response(uuid, text, text, text, timestamptz) to authenticated;


-- ---------------- 代行回答（20260803210000 の定義に緊急通知を足したもの） ----------------
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
declare
  v_rows int;
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

  get diagnostics v_rows = row_count;

  insert into safety_check_response_log (check_id, user_id, choice, comment, is_proxy, proxy_by)
  values (p_check_id, p_target_user_id, p_choice, nullif(btrim(coalesce(p_comment,'')),''), true, auth.uid());

  -- 電話で聞き取った内容が「助けが必要」だったときも同じように知らせる
  if v_rows > 0 and safety_choice_is_urgent(p_check_id, p_choice) then
    update safety_check_responses set urgent_notified_at = now()
     where check_id = p_check_id and user_id = p_target_user_id and urgent_notified_at is null;
    if found then
      perform notify_safety_urgent(p_check_id, p_target_user_id);
    end if;
  elsif v_rows > 0 then
    update safety_check_responses set urgent_notified_at = null
     where check_id = p_check_id and user_id = p_target_user_id and urgent_notified_at is not null;
  end if;
end;
$$;

grant execute on function submit_safety_response_proxy(uuid, uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
