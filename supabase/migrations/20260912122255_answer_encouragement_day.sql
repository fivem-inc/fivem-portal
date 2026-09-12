-- 🚨🚨 本人が「受理済み」の休暇を自分で作れる穴を塞ぐ（第1段：専用処理を作る）
--
-- 【何が問題か（2026-09-12 本番で実測）】
--   `leave_requests` の INSERT の許可 `insert_own` は `auth.uid() = user_id` だけで、
--   **状態（status）を見ていない**（守るトリガーも無い）。
--   ＝画面を通さなければ、ログイン中の誰でも自分の休暇を `status='approved'`（最終受理済み）で作れる。
--   受理の流れ（1人目 → 2人目 → 経理 → 社長）を丸ごと飛ばせる。
--   🚨 さらに UPDATE の許可 `update_admin` には **WITH CHECK が無く USING が流用される**ため、
--      「未受理・受理者＝自分」で作ってから自分で `approved` に書き換える道もある。
--      → そちらは**第3段**（別ファイル）で塞ぐ。この第1段だけでは塞がらない。
--
-- 【なぜ許可をすぐ締められないか】
--   有給奨励日の回答が、この同じ入口を使って**本人が受理済みの休暇を作っている**
--   （本番の休暇71件のうち50件がこれ。1日最大20件）。締めると回答が動かなくなる。
--   → 谷間を作らないため、**①専用処理を作る（このファイル）→ ②画面を差し替えて出す →
--     ③許可を締める** の順で進める（2026-09-11 の fcec026 → 9e4fd12 と同じ形）。
--
-- 【この関数がやること】
--   ・選択肢の検査（1〜4／4は補足が必須）
--   ・**その日の対象者に自分がいるか**を確かめる（画面の判定に頼らない）
--   ・回答を1件入れる（同じ奨励日・同じ人は1件だけ。2回目は ok=false で止める）
--   ・休暇を1件作る（いまの画面とまったく同じ値。種別・補足・日付・purpose・reason・status・current_approver）
--   ・🚨 **「この日は出勤します」にチェックが入っていれば休暇は作らない**（2026-09-12 ユーザー確定）。
--     実データに「その他（出勤 選手・育成の為）」のように**出勤なのに休暇の記録が残っている行が2件**あった。
--     🚨 文章に「出勤」と書いてあるかで判定しない（「仕事のため」を取りこぼし、「出勤しません」を誤判定する）。
--     場所予約の「別枠で予約」を印にしたのと同じ考え方。
--   ・🚨 締切は見ない（2026-09-12 ユーザー確定）。ホームの案内は締切後も「回答が未完了です」と出す作りで、
--     ここで止めると回答できない人が残る。
--   ・回答と休暇を**1つの処理**で作る（いまは画面が2回に分けて書いており、2回押すと
--     回答だけ失敗して**受理済みの休暇だけ二重に増える**。ここも同時に直る）
--
-- 【戻り値】ok / reason の2列（`set_leave_shift_adjust` と同じ形）。
--   🚨 例外ではなく ok=false と理由を返す。画面はその文字をそのまま出せる。
--   🚨 `supabase.rpc()` は 4xx/5xx でも throw しないので、画面側は error と ok の両方を見ること。

create or replace function public.answer_encouragement_day(
  p_day_id  uuid,
  p_choice  integer,
  p_note    text default null,
  p_working boolean default false
) returns table (ok boolean, reason text)
language plpgsql security definer set search_path = public as $$
declare
  v_uid          uuid := auth.uid();
  v_target_date  date;
  v_note         text := nullif(btrim(coalesce(p_note, '')), '');
  v_leave_type   text;
  v_type_other   text;
  v_inserted     integer;
begin
  if v_uid is null then
    return query select false, 'ログインが必要です'::text; return;
  end if;
  if p_choice is null or p_choice not in (1, 2, 3, 4) then
    return query select false, '回答を選んでください'::text; return;
  end if;
  if p_choice = 4 and v_note is null then
    return query select false, '「その他」を選んだときは内容を書いてください'::text; return;
  end if;

  -- その日の対象者か（画面の出し分けに頼らず、ここで確かめる）
  select d.target_date into v_target_date
  from paid_leave_encouragement_days d
  join paid_leave_encouragement_targets t
    on t.encouragement_day_id = d.id and t.user_id = v_uid
  where d.id = p_day_id;

  if v_target_date is null then
    return query select false, 'この有給奨励日の対象ではありません'::text; return;
  end if;

  -- 回答（同じ奨励日・同じ人は1件だけ。2回目はここで止める）
  insert into paid_leave_encouragement_responses (encouragement_day_id, user_id, choice, note)
  values (p_day_id, v_uid, p_choice, v_note)
  on conflict (encouragement_day_id, user_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return query select false, 'すでに回答済みです'::text; return;
  end if;

  -- 休暇（いまの画面と同じ値。🚨 出勤のチェックが入っていれば作らない）
  if not (p_choice = 4 and coalesce(p_working, false)) then
    v_leave_type := case p_choice when 1 then '有給休暇' when 2 then '調整休' else 'その他' end;
    v_type_other := case p_choice when 3 then '定休日' when 4 then coalesce(v_note, 'その他') else null end;

    -- 何度動いても二重にならないよう、同じ人・同じ日・奨励日由来の行が無いときだけ作る
    -- 🚨 表の別名（lr）を必ず付ける。`reason` は**戻り値の名前でもある**ので、裸で書くと
    --    「どちらの reason か分からない」で落ちる（42702）。場所予約の繰り上げで同じ形を踏んでいる
    if not exists (
      select 1 from leave_requests lr
      where lr.user_id = v_uid and lr.start_date = v_target_date and lr.reason = '【有給奨励日】'
    ) then
      insert into leave_requests (
        user_id, leave_type, leave_type_other, leave_dates, start_date, end_date,
        purpose, reason, status, current_approver
      ) values (
        v_uid, v_leave_type, v_type_other,
        to_json(array[to_char(v_target_date, 'YYYY-MM-DD')])::text,
        v_target_date, v_target_date,
        '有給奨励日', '【有給奨励日】', 'approved', 'none'
      );
    end if;
  end if;

  return query select true, null::text;
end;
$$;

comment on function public.answer_encouragement_day(uuid, integer, text, boolean) is
  '有給奨励日の回答を保存し、必要なら受理済みの休暇を1件作る。対象者かどうかを関数の中で確かめる。'
  '「その他＋この日は出勤します」のときは休暇を作らない（2026-09-12）。';

-- 🚨 新しい関数は anon の実行権限を明示的に外す（CLAUDE.md の決まり。from public だけでは外れない）
revoke execute on function public.answer_encouragement_day(uuid, integer, text, boolean) from public;
revoke execute on function public.answer_encouragement_day(uuid, integer, text, boolean) from anon;
grant  execute on function public.answer_encouragement_day(uuid, integer, text, boolean) to authenticated;

-- 🚨 ついでに、匿名でも実行できるままだった既存の2本も外す（2026-09-12 ユーザー確定）
--    どちらも auth.uid() を見るので匿名では対象が0件になるが、決まりどおり明示的に外しておく。
--    🚨 has_feature_permission は**外さない**。DB の許可（RLS）の判定そのものに使われており、
--       外すと匿名での判定が「拒否」ではなく「エラー」になるおそれがある。
revoke execute on function public.cancel_own_leave(uuid) from anon;
revoke execute on function public.edit_own_leave(uuid, text, text, text, text, text, text, date, date, text) from anon;
