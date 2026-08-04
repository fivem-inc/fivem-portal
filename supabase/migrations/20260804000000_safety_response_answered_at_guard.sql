-- ========================================
-- 安否確認：古い回答が、あとから記録された新しい回答を上書きしないようにする
--
-- 【なぜ必要か】
--   オフラインで押した回答は端末に保存され、電波が戻ってから送られる。
--   そのため「圏外のときに押した数時間前の『無事です』」が、
--   その後に電話で確認して代行入力した『被害あり・助けが必要』を
--   あとから上書きしてしまう、ということが起こりうる。
--   安否確認は「誰が入れたか」ではなく「いつの情報か」で新しい方を残さないといけない。
--
-- 【やること】
--   本人回答のRPCに「本人がボタンを押した時刻」を渡せるようにし、
--   すでに記録されている回答の方が新しければ上書きしない。
--   上書きしたかどうかを呼び出し側に返し、本人に知らせられるようにする。
--
-- ⚠️ 戻り値を void → jsonb に変えるため、いったん drop してから作り直す
--    （CREATE OR REPLACE では戻り値の型を変えられないため）。
--    p_answered_at は既定値つきなので、古いクライアント（4つの引数で呼ぶ）からも
--    そのまま呼べる＝デプロイ順序による事故は起きない。
-- ========================================

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
  -- サーバーの現在時刻を上限にして丸める。
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

  -- 反映されなかった回答も履歴には残す（あとから経緯を追えるようにするため）
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

  return jsonb_build_object('applied', v_applied);
end;
$$;

grant execute on function submit_safety_response(uuid, text, text, text, timestamptz) to authenticated;

-- PostgREST に関数の変更を読み直させる
notify pgrst, 'reload schema';
