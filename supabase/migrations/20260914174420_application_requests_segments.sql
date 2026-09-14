-- 申請の依頼に「入る時間と校」を持たせる（2026-09-14 ユーザー確定）
--
-- 【なぜ】シフト調整で正社員を入れて決定すると、本人に「残業申請の依頼」が届く。
--   ところが依頼の記録（application_requests）には日付しか無く、残業ページの依頼カードにも、
--   そこから開く申請の画面にも時間が出なかった（「依頼が来ても時間が分からない」）。
--
-- 【何をするか】
--   ① application_requests に segments（jsonb・空を許す）を1列足す。形は shift_adjust_assignments.segments と同じ
--      [{ "start": "10:00", "end": "13:00", "location": "四条本校" }]
--      🚨 空（null）を許す。上長が画面から送る依頼（ApplicationRequestSheet）には時間が無いので null のまま
--   ② shift_adjust_decide が依頼を作るとき、その人の segments も書く
--      🚨 本番の実定義（pg_get_functiondef・2026-09-14 17:44 取得）から起こし、insert の1文だけ変えた。
--         引数も戻り値も同じなので create or replace のみ（実行権限はそのまま）
--
-- 🚨 RLS は触らない（列が増えても、今までどおり本人・依頼した人・管理者だけが読める）

alter table public.application_requests
  add column if not exists segments jsonb;

comment on column public.application_requests.segments is
  '入る時間と校（[{start,end,location}]）。シフト調整の決定で作った依頼だけに入る。上長が画面から送った依頼は null（2026-09-14）';

CREATE OR REPLACE FUNCTION public.shift_adjust_decide(p_slot_id uuid, p_assignments jsonb, p_do_attendance boolean DEFAULT true, p_do_request boolean DEFAULT true, p_memo text DEFAULT NULL::text)
 RETURNS TABLE(ok boolean, reason text, request_ids uuid[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
        -- 🚨 2026-09-14：入る時間と校（segments）も依頼に書く。残業ページの依頼カードと申請の画面が使う
        insert into application_requests (requester_id, recipient_id, kind, target_dates, memo, segments)
        values (auth.uid(), v_uid, 'overtime', array[v_slot.target_date], nullif(p_memo, ''), v_segs)
        returning id into v_req_id;
        v_reqs := v_reqs || v_req_id;
      end if;

      insert into shift_adjust_assignments
        (slot_id, user_id, segments, kind, attendance_exception_id, application_request_id)
      values (p_slot_id, v_uid, v_segs, v_kind, v_ae_id, v_req_id);
    end loop;

    -- 出勤のお願いを送ってあった人の「決まった印」。パートの返事の画面が使う
    -- 🚨 2026-09-13（手順8）：「入った人だけ true」から「入った人は true・それ以外は false」に。
    --    取り消して別の方で決め直したとき、前の方の印が残らないように
    update shift_adjust_part_requests r
       set picked = (r.user_id in (select a.user_id from shift_adjust_assignments a where a.slot_id = p_slot_id))
     where r.slot_id = p_slot_id;

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

  -- 🚨 2026-09-13（手順8）：選ばれなかった方への連絡（設定が「ベルでも知らせる」のときだけ）
  begin
    if coalesce((select st.notify_unpicked from shift_adjust_settings st where st.id = 1), 'screen') = 'bell' then
      insert into notifications (user_id, message, sub_message, source_type, reference_id)
      select r.user_id,
             '📅 ' || to_char(v_slot.target_date, 'FMMM/FMDD') || 'の出勤のお願いについて',
             'この日の担当は決定しました。ご返事ありがとうございました。',
             'shift_adjust:part_request_closed',
             r.id::text
        from shift_adjust_part_requests r
       where r.slot_id = p_slot_id
         and not r.picked
         and not exists (
               select 1 from notifications n
                where n.user_id = r.user_id
                  and n.source_type = 'shift_adjust:part_request_closed'
                  and n.reference_id = r.id::text);
    end if;
  exception when others then
    raise warning '[shift_adjust_decide] 選ばれなかった方への連絡を送れませんでした: %', sqlerrm;
  end;

  return query select true, ''::text, v_reqs;
end $function$;
