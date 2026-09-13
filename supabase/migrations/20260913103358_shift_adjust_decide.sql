-- シフト調整：決定する／決定を取り消す（手順6-B）
-- 設計は docs/計画-シフト調整.md。
--
-- 【この2つの関数でやること】
--   shift_adjust_decide   … 誰がどの時間帯に入るかを決め、必要なら
--                            パート＝勤怠に休日出勤を登録／正社員＝残業申請の依頼を出す
--   shift_adjust_undecide … その決定を取り消し、登録した勤怠を消し、依頼を取り下げる
--
-- 【🚨 いちばん大事な決まり：途中で失敗したら全部やめる】
--   勤怠の登録は `enforce_attendance_exclusive` に弾かれることがある（同じ日にすでに
--   別の記録があると 23514）。そこで失敗したのに割り当てだけ残ると、
--   「決まっていることになっているのに、出勤の記録が無い」状態になる。
--   → **書き込みを1つの begin…exception で包み、失敗したら何も残さずに理由を返す**。
--
-- 【🚨 通知はこの関数から送らない】
--   DBからは Edge Function を呼べない。依頼のお知らせは、いまの申請依頼
--   （ApplicationRequestSheet）と同じく**画面から送る**。そのために作った依頼のIDを返す。
--
-- 【🚨 古い列（leave_requests.shift_adjust_status）は書かない】
--   手順4のトリガーが、場の状態が変わった瞬間に自動で書き写す。ここに書くと二重になる。

-- ───────────────────────────────────────────────────────────────
-- 1. 決定する
-- ───────────────────────────────────────────────────────────────
-- p_assignments の形（画面が作る）:
--   [{"user_id":"…","kind":"attendance","segments":[{"start":"09:30","end":"13:00","location":"四条本校"}]}]
--   kind … 'attendance'（パート＝勤怠に登録）／'overtime_request'（正社員＝残業申請を依頼）
create or replace function public.shift_adjust_decide(
  p_slot_id        uuid,
  p_assignments    jsonb,
  p_do_attendance  boolean default true,
  p_do_request     boolean default true,
  p_memo           text    default null
) returns table(ok boolean, reason text, request_ids uuid[])
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_is_admin  boolean;
  v_slot      shift_adjust_slots%rowtype;
  v_a         jsonb;
  v_uid       uuid;
  v_kind      text;
  v_segs      jsonb;
  v_first     jsonb;
  v_loc       text;
  v_ae_id     uuid;
  v_req_id    uuid;
  v_reqs      uuid[] := '{}';
  v_name      text;
  v_can_ot    boolean;
begin
  v_is_admin := coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
  if not (v_is_admin or public.has_feature_permission('shift_adjust_decide')) then
    return query select false, 'シフト調整を決める権限がありません（管理画面の「役職・機能権限」で設定します）'::text, null::uuid[];
    return;
  end if;

  if p_assignments is null or jsonb_typeof(p_assignments) <> 'array' or jsonb_array_length(p_assignments) = 0 then
    return query select false, '入る人が1人も選ばれていません'::text, null::uuid[];
    return;
  end if;

  -- 🚨 行を押さえてから見る。2人が同時に押したときに、後の人が古い中身で判断しないように
  select * into v_slot from shift_adjust_slots s where s.id = p_slot_id for update;
  if not found then
    return query select false, 'この調整の場は見つかりません'::text, null::uuid[];
    return;
  end if;
  if v_slot.target_user_id = auth.uid() then
    return query select false, '自分の休みの調整は、この画面からは決められません'::text, null::uuid[];
    return;
  end if;
  if v_slot.status in ('closed_past', 'cause_cancelled') then
    return query select false, 'この場はもう閉じています（過ぎた日、または休みが取り消されました）'::text, null::uuid[];
    return;
  end if;
  if exists (select 1 from shift_adjust_assignments a where a.slot_id = p_slot_id) then
    return query select false, 'すでに決まっています。変えるときは先に「決定を取り消す」を押してください'::text, null::uuid[];
    return;
  end if;

  -- ═══ ここから書き込み。🚨 どれか1つでも失敗したら、全部やめる ═══
  begin
    for v_a in select * from jsonb_array_elements(p_assignments) loop
      v_uid  := (v_a ->> 'user_id')::uuid;
      v_kind := v_a ->> 'kind';
      v_segs := coalesce(v_a -> 'segments', '[]'::jsonb);

      if v_uid is null then
        raise exception '入る人が選ばれていません' using errcode = 'P0001';
      end if;
      if v_kind not in ('attendance', 'overtime_request') then
        raise exception '登録のしかたの指定が正しくありません' using errcode = 'P0001';
      end if;
      if jsonb_array_length(v_segs) = 0 then
        raise exception '時間帯が入っていません' using errcode = 'P0001';
      end if;
      -- 🚨 休んだ本人を代わりに入れない（同じ日に休みと出勤が両方できてしまう）
      if v_uid = v_slot.target_user_id then
        raise exception '休んでいる本人を代わりに入れることはできません' using errcode = 'P0001';
      end if;

      select pr.name into v_name from profiles pr where pr.id = v_uid;
      v_first := v_segs -> 0;
      v_loc   := nullif(v_first ->> 'location', '');

      v_ae_id  := null;
      v_req_id := null;

      if v_kind = 'attendance' and p_do_attendance then
        -- 🚨 同じ日にすでに記録があると enforce_attendance_exclusive が 23514 で止める。
        --    そのときは下の exception で受けて、何も残さずに理由を返す
        insert into attendance_exceptions (user_id, date, type, actual_time, location, work_segments, notes, created_by)
        values (v_uid, v_slot.target_date, 'holiday_work',
                (v_first ->> 'start')::time, v_loc, v_segs,
                nullif(p_memo, ''), auth.uid())
        returning id into v_ae_id;

      elsif v_kind = 'overtime_request' and p_do_request then
        -- 🚨 残業申請の権限が無い人に依頼を出すと、本人は申請できない（届くのに何もできない）
        select exists (
          select 1 from profiles pr
            join feature_permissions fp on fp.role_id = pr.role_id
           where pr.id = v_uid and fp.feature_key = 'overtime' and fp.enabled
        ) into v_can_ot;
        if not v_can_ot then
          raise exception '%さんは残業申請を使えません。勤怠での登録に切り替えるか、別の方を選んでください',
            coalesce(v_name, 'この方') using errcode = 'P0001';
        end if;
        insert into application_requests (requester_id, recipient_id, kind, target_dates, memo)
        values (auth.uid(), v_uid, 'overtime', array[v_slot.target_date], nullif(p_memo, ''))
        returning id into v_req_id;
        v_reqs := v_reqs || v_req_id;
      end if;

      insert into shift_adjust_assignments
        (slot_id, user_id, segments, kind, attendance_exception_id, application_request_id)
      values (p_slot_id, v_uid, v_segs, v_kind, v_ae_id, v_req_id);
    end loop;

    update shift_adjust_slots s
       set status = 'decided', decided_by = auth.uid(), decided_at = now(), updated_at = now()
     where s.id = p_slot_id;

  exception
    when sqlstate '23514' then
      -- 勤怠の重なり。文面は enforce_attendance_exclusive が作ったものをそのまま出す
      return query select false, sqlerrm::text, null::uuid[];
      return;
    when sqlstate '23505' then
      return query select false, '同じ人を2回選んでいます'::text, null::uuid[];
      return;
    when others then
      return query select false, sqlerrm::text, null::uuid[];
      return;
  end;

  return query select true, ''::text, v_reqs;
end $function$;

comment on function public.shift_adjust_decide(uuid, jsonb, boolean, boolean, text) is
  'シフト調整の決定。割り当て＋（パート）勤怠の休日出勤＋（正社員）残業申請の依頼を1つの処理で行う。'
  '🚨 どれか1つでも失敗したら何も残さない。🚨 通知は画面から送る（作った依頼のIDを返す）。';

-- ───────────────────────────────────────────────────────────────
-- 2. 決定を取り消す
-- ───────────────────────────────────────────────────────────────
-- 🚨 登録した勤怠は**消す**。依頼は**取り下げる**（消さない）。
--    依頼は相手に届いていて、やり取りの記録が残るため（申請依頼の既存の考え方に合わせる）。
create or replace function public.shift_adjust_undecide(p_slot_id uuid)
returns table(ok boolean, reason text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_is_admin boolean;
  v_slot     shift_adjust_slots%rowtype;
begin
  v_is_admin := coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
  if not (v_is_admin or public.has_feature_permission('shift_adjust_decide')) then
    return query select false, 'シフト調整を決める権限がありません'::text;
    return;
  end if;

  select * into v_slot from shift_adjust_slots s where s.id = p_slot_id for update;
  if not found then
    return query select false, 'この調整の場は見つかりません'::text;
    return;
  end if;
  if v_slot.target_user_id = auth.uid() then
    return query select false, '自分の休みの調整は、この画面からは変えられません'::text;
    return;
  end if;

  begin
    -- 登録した勤怠を消す（この決定で作ったものだけ。手で入れた記録は触らない）
    delete from attendance_exceptions ae
     where ae.id in (select a.attendance_exception_id from shift_adjust_assignments a
                      where a.slot_id = p_slot_id and a.attendance_exception_id is not null);

    -- 依頼は取り下げる。🚨 すでに申請が済んでいるもの（applied）は触らない
    update application_requests ar
       set status = 'withdrawn', updated_at = now()
     where ar.id in (select a.application_request_id from shift_adjust_assignments a
                      where a.slot_id = p_slot_id and a.application_request_id is not null)
       and ar.status = 'open';

    delete from shift_adjust_assignments a where a.slot_id = p_slot_id;

    -- 🚨 「未調整」ではなく「調整中」に戻す。まだ誰かが手を付けている状態だから
    update shift_adjust_slots s
       set status = 'working', decided_by = null, decided_at = null, updated_at = now()
     where s.id = p_slot_id;
  exception when others then
    return query select false, ('取り消せませんでした：' || sqlerrm)::text;
    return;
  end;

  return query select true, ''::text;
end $function$;

comment on function public.shift_adjust_undecide(uuid) is
  'シフト調整の決定を取り消す。登録した勤怠は消し、依頼は取り下げる（申請済みのものは触らない）。場は「調整中」に戻る。';

-- ───────────────────────────────────────────────────────────────
-- 3. 「調整する」で 未調整 → 調整中 にする
-- ───────────────────────────────────────────────────────────────
-- 🚨 手順6-A で作った shift_adjust_set_status は pending と no_change だけだった。
--    画面を「まず二択」の形にしたので、working も受け付けるようにする
--    （2026-09-13 実機のご指摘：開いた瞬間に「誰が入るか」が出るのは順番が逆）。
-- 🚨 working は「未調整」と同じ扱い（お知らせは止まらない）。片付いたわけではないため。
create or replace function public.shift_adjust_set_status(
  p_slot_id uuid,
  p_status  text
) returns table(ok boolean, reason text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_is_admin boolean;
  v_slot     shift_adjust_slots%rowtype;
  v_has_assign boolean;
begin
  if p_status not in ('pending', 'working', 'no_change') then
    return query select false, '状態の値が正しくありません'::text;
    return;
  end if;

  v_is_admin := coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
  if not (v_is_admin or public.has_feature_permission('shift_adjust_decide')) then
    return query select false, 'シフト調整を決める権限がありません（管理画面の「役職・機能権限」で設定します）'::text;
    return;
  end if;

  select * into v_slot from shift_adjust_slots s where s.id = p_slot_id for update;
  if not found then
    return query select false, 'この調整の場は見つかりません'::text;
    return;
  end if;
  if v_slot.target_user_id = auth.uid() then
    return query select false, '自分の休みの調整は、この画面からは変えられません'::text;
    return;
  end if;

  select exists (select 1 from shift_adjust_assignments a where a.slot_id = p_slot_id)
    into v_has_assign;
  if v_has_assign then
    return query select false, 'すでに出勤する人が決まっています。先に「決定を取り消す」から片付けてください'::text;
    return;
  end if;

  if v_slot.status in ('closed_past', 'cause_cancelled') then
    return query select false, 'この場はもう閉じています（過ぎた日、または休みが取り消されました）'::text;
    return;
  end if;

  update shift_adjust_slots s
     set status     = p_status,
         -- 🚨 「誰がやったか」は確認済み（変更なし）のときだけ残す。
         --    調整中は「まだ決めていない」ので、決めた人を書かない
         decided_by = case when p_status = 'no_change' then auth.uid() else null end,
         decided_at = case when p_status = 'no_change' then now() else null end,
         updated_at = now()
   where s.id = p_slot_id;

  return query select true, ''::text;
end $function$;

-- 🚨 CLAUDE.md の決まり：PUBLIC から外す → ログイン済みに与え直す → anon からも外す
revoke execute on function public.shift_adjust_decide(uuid, jsonb, boolean, boolean, text) from public;
grant  execute on function public.shift_adjust_decide(uuid, jsonb, boolean, boolean, text) to authenticated;
revoke execute on function public.shift_adjust_decide(uuid, jsonb, boolean, boolean, text) from anon;

revoke execute on function public.shift_adjust_undecide(uuid) from public;
grant  execute on function public.shift_adjust_undecide(uuid) to authenticated;
revoke execute on function public.shift_adjust_undecide(uuid) from anon;

revoke execute on function public.shift_adjust_set_status(uuid, text) from public;
grant  execute on function public.shift_adjust_set_status(uuid, text) to authenticated;
revoke execute on function public.shift_adjust_set_status(uuid, text) from anon;
