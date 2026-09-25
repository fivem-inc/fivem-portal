-- ============================================================
-- 2026-09-25  シフト調整：「決定を取り消す」で「この方に決定」の印を外す
-- ============================================================
-- 🚨 本番の実定義（pg_get_functiondef・2026-09-25 取得）から起こし、1か所だけ足した。
--    足したのは、出勤のお願いの picked を false に戻す update だけ。ほかの行は1文字も変えていない。
-- ・取り消しを本人に知らせるベル・スマホの通知は画面（ShiftAdjustTab）から送る（決定のときと同じ作り）
-- ・引数・戻り値は変えていない（create or replace で足りる）

CREATE OR REPLACE FUNCTION public.shift_adjust_undecide(p_slot_id uuid)
 RETURNS TABLE(ok boolean, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

    -- 「この方に決定」の印を外す（2026-09-25）。外さないと、取り消したのに決まっているように見えていた
    update shift_adjust_part_requests pr
       set picked = false
     where pr.slot_id = p_slot_id and pr.picked;

    -- 🚨 「未調整」ではなく「調整中」に戻す。まだ誰かが手を付けている状態だから
    update shift_adjust_slots s
       set status = 'working', decided_by = null, decided_at = null, updated_at = now()
     where s.id = p_slot_id;
  exception when others then
    return query select false, ('取り消せませんでした：' || sqlerrm)::text;
    return;
  end;

  return query select true, ''::text;
end $function$
;

revoke execute on function public.shift_adjust_undecide(uuid) from anon;
