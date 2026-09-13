-- シフト調整：パートへの「出勤のお願い」（手順7）
-- 設計は docs/計画-シフト調整.md の「5. パートへの依頼」。
--
-- 【なぜ関数が要るか】
--   手順2で `shift_adjust_part_requests` に**読み取りの許可しか作らなかった**。
--   送るのも答えるのも確かめることが多いので、関数に寄せる。
--
-- 【🚨 パートは調整の場を読めない】
--   `shift_adjust_slots` の読み取りは `shift_adjust_view` の権限が要り、パートは持たない。
--   なので「もう決まったのか」をパート自身は調べられない。
--   → **`shift_adjust_my_part_requests()`**（SECURITY DEFINER）が、
--     自分あての依頼と「決まったかどうか」だけをまとめて返す。
--     🚨 **誰の代わりかは返さない**（休んだ人の名前・休暇の種類は相手に見せない）。
--
-- 【🚨 呼び名】「出勤のお願い」（既存の「申請の依頼」＝ application_requests と紛れないように）

-- ───────────────────────────────────────────────────────────────
-- 1. 送る
-- ───────────────────────────────────────────────────────────────
create or replace function public.shift_adjust_send_part_requests(
  p_slot_id  uuid,
  p_user_ids uuid[],
  p_segments jsonb,
  p_location text        default null,
  p_due_at   timestamptz default null
) returns table(ok boolean, reason text, request_ids uuid[], sent_names text[])
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_is_admin boolean;
  v_slot     shift_adjust_slots%rowtype;
  v_uid      uuid;
  v_id       uuid;
  v_ids      uuid[] := '{}';
  v_names    text[] := '{}';
  v_name     text;
  v_emp      text;
begin
  v_is_admin := coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
  if not (v_is_admin or public.has_feature_permission('shift_adjust_request')) then
    return query select false, 'パートへ出勤のお願いを送る権限がありません（管理画面の「役職・機能権限」で設定します）'::text,
                        null::uuid[], null::text[];
    return;
  end if;

  if p_user_ids is null or array_length(p_user_ids, 1) is null then
    return query select false, '送る相手が選ばれていません'::text, null::uuid[], null::text[];
    return;
  end if;
  if p_segments is null or jsonb_typeof(p_segments) <> 'array' or jsonb_array_length(p_segments) = 0 then
    return query select false, '時間帯が入っていません'::text, null::uuid[], null::text[];
    return;
  end if;

  select * into v_slot from shift_adjust_slots s where s.id = p_slot_id for update;
  if not found then
    return query select false, 'この調整の場は見つかりません'::text, null::uuid[], null::text[];
    return;
  end if;
  if v_slot.target_user_id = auth.uid() then
    return query select false, '自分の休みの調整は、この画面からは送れません'::text, null::uuid[], null::text[];
    return;
  end if;
  if v_slot.status in ('closed_past', 'cause_cancelled', 'no_change') then
    return query select false, 'この場はもう閉じています'::text, null::uuid[], null::text[];
    return;
  end if;

  -- 🚨 途中で失敗したら何も残さない（決定と同じ形）
  begin
    foreach v_uid in array p_user_ids loop
      if v_uid = v_slot.target_user_id then
        raise exception '休んでいる本人に出勤のお願いは送れません' using errcode = 'P0001';
      end if;

      select pr.name, pr.employment_type into v_name, v_emp from profiles pr where pr.id = v_uid;
      if v_name is null then
        raise exception '送る相手が見つかりません' using errcode = 'P0001';
      end if;
      -- 🚨 パート以外には送らない。正社員は「残業申請の依頼」（決定のときに出る）が正しい道
      if v_emp is distinct from 'パート' then
        raise exception '%さんはパートではありません。正社員には決定のときに残業申請を依頼します', v_name
          using errcode = 'P0001';
      end if;

      -- すでに送ってある相手は飛ばす（二度押しで増やさない）
      insert into shift_adjust_part_requests
        (slot_id, user_id, target_date, segments, location, due_at)
      values (p_slot_id, v_uid, v_slot.target_date, p_segments, nullif(p_location, ''), p_due_at)
      on conflict (slot_id, user_id) do nothing
      returning id into v_id;

      if v_id is not null then
        v_ids   := v_ids || v_id;
        v_names := v_names || v_name;
        v_id    := null;
      end if;
    end loop;

    -- まだ未調整なら「調整中」にする（誰かが動き出した、が他の人に伝わる）
    if v_slot.status = 'pending' then
      update shift_adjust_slots s
         set status = 'working', updated_at = now()
       where s.id = p_slot_id;
    end if;
  exception when others then
    return query select false, sqlerrm::text, null::uuid[], null::text[];
    return;
  end;

  if array_length(v_ids, 1) is null then
    return query select false, '選んだ方には、すでに送ってあります'::text, null::uuid[], null::text[];
    return;
  end if;

  return query select true, ''::text, v_ids, v_names;
end $function$;

comment on function public.shift_adjust_send_part_requests(uuid, uuid[], jsonb, text, timestamptz) is
  'パートへ「出勤のお願い」を送る。🚨 パート以外・休んだ本人には送らない。'
  '🚨 すでに送ってある相手は飛ばす。通知は画面から送る（作った依頼のIDと名前を返す）。';

-- ───────────────────────────────────────────────────────────────
-- 2. 答える（パート本人）
-- ───────────────────────────────────────────────────────────────
-- 🚨 期限を過ぎていても答えられる。締め切ると「入れます」と言える人を断ることになる。
--    期限は「いつまでに返事がほしいか」の目安で、送った人の画面に「返事なし」と出すためのもの。
create or replace function public.shift_adjust_answer_part_request(
  p_request_id uuid,
  p_answer     text
) returns table(ok boolean, reason text)
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_req shift_adjust_part_requests%rowtype;
begin
  if p_answer not in ('yes', 'no') then
    return query select false, '返事の値が正しくありません'::text;
    return;
  end if;

  select * into v_req from shift_adjust_part_requests r where r.id = p_request_id for update;
  if not found then
    return query select false, 'この出勤のお願いは見つかりません'::text;
    return;
  end if;
  -- 🚨 本人だけ。ほかの人の返事を書き換えられないようにする
  if v_req.user_id <> auth.uid() then
    return query select false, 'このお願いはあなた宛ではありません'::text;
    return;
  end if;

  update shift_adjust_part_requests r
     set answer = p_answer, answered_at = now()
   where r.id = p_request_id;

  return query select true, ''::text;
end $function$;

comment on function public.shift_adjust_answer_part_request(uuid, text) is
  'パート本人が「入れます／入れません」を返す。🚨 期限を過ぎていても答えられる（断ると、入れる人を逃す）。';

-- ───────────────────────────────────────────────────────────────
-- 3. 自分あての「出勤のお願い」を読む（パート用）
-- ───────────────────────────────────────────────────────────────
-- 🚨 パートは `shift_adjust_slots` を読めないので、「もう決まったか」を自分では調べられない。
--    ここでまとめて返す。🚨 **誰の代わりかは返さない**。
create or replace function public.shift_adjust_my_part_requests()
returns table(
  id          uuid,
  target_date date,
  segments    jsonb,
  location    text,
  due_at      timestamptz,
  answer      text,
  answered_at timestamptz,
  picked      boolean,
  decided     boolean
)
language sql
security definer
set search_path to 'public'
stable
as $function$
  select r.id, r.target_date, r.segments, r.location, r.due_at,
         r.answer, r.answered_at, r.picked,
         (s.status = 'decided') as decided
    from shift_adjust_part_requests r
    join shift_adjust_slots s on s.id = r.slot_id
   where r.user_id = auth.uid()
     and r.target_date >= (now() at time zone 'Asia/Tokyo')::date
   order by r.target_date;
$function$;

comment on function public.shift_adjust_my_part_requests() is
  '自分あての「出勤のお願い」（本日以降）と、その日がもう決まったかどうか。'
  '🚨 誰の代わりかは返さない（休んだ人の名前・休暇の種類は相手に見せない）。';

-- ───────────────────────────────────────────────────────────────
-- 4. 決定したら、その人の「出勤のお願い」に印を付ける
-- ───────────────────────────────────────────────────────────────
-- 🚨 本番の実定義から起こしたのではなく、2026-09-13 に自分が作った版（20260913103358）に
--    1か所足しただけ。足したのは「割り当てを入れたあとに picked を立てる」処理。
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
      if v_uid = v_slot.target_user_id then
        raise exception '休んでいる本人を代わりに入れることはできません' using errcode = 'P0001';
      end if;

      select pr.name into v_name from profiles pr where pr.id = v_uid;
      v_first := v_segs -> 0;
      v_loc   := nullif(v_first ->> 'location', '');

      v_ae_id  := null;
      v_req_id := null;

      if v_kind = 'attendance' and p_do_attendance then
        insert into attendance_exceptions (user_id, date, type, actual_time, location, work_segments, notes, created_by)
        values (v_uid, v_slot.target_date, 'holiday_work',
                (v_first ->> 'start')::time, v_loc, v_segs,
                nullif(p_memo, ''), auth.uid())
        returning id into v_ae_id;

      elsif v_kind = 'overtime_request' and p_do_request then
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

    -- 🚨 2026-09-13 追加：出勤のお願いを送ってあった人が決まったら、その依頼に印を付ける。
    --    パートの返事の画面が「この日の担当は決定しました」を出すのに使う
    update shift_adjust_part_requests r
       set picked = true
     where r.slot_id = p_slot_id
       and r.user_id in (select a.user_id from shift_adjust_assignments a where a.slot_id = p_slot_id);

    update shift_adjust_slots s
       set status = 'decided', decided_by = auth.uid(), decided_at = now(), updated_at = now()
     where s.id = p_slot_id;

  exception
    when sqlstate '23514' then
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

-- 🚨 CLAUDE.md の決まり：PUBLIC から外す → ログイン済みに与え直す → anon からも外す
revoke execute on function public.shift_adjust_send_part_requests(uuid, uuid[], jsonb, text, timestamptz) from public;
grant  execute on function public.shift_adjust_send_part_requests(uuid, uuid[], jsonb, text, timestamptz) to authenticated;
revoke execute on function public.shift_adjust_send_part_requests(uuid, uuid[], jsonb, text, timestamptz) from anon;

revoke execute on function public.shift_adjust_answer_part_request(uuid, text) from public;
grant  execute on function public.shift_adjust_answer_part_request(uuid, text) to authenticated;
revoke execute on function public.shift_adjust_answer_part_request(uuid, text) from anon;

revoke execute on function public.shift_adjust_my_part_requests() from public;
grant  execute on function public.shift_adjust_my_part_requests() to authenticated;
revoke execute on function public.shift_adjust_my_part_requests() from anon;

revoke execute on function public.shift_adjust_decide(uuid, jsonb, boolean, boolean, text) from public;
grant  execute on function public.shift_adjust_decide(uuid, jsonb, boolean, boolean, text) to authenticated;
revoke execute on function public.shift_adjust_decide(uuid, jsonb, boolean, boolean, text) from anon;
