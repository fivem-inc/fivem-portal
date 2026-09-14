-- シフト調整：「対応の選択」を選び直せるようにする（2026-09-14 実機指摘・ユーザー確定）
--
-- 画面は「シフトを調整する／現行シフトで対応／後で決める」を、出勤する人が決まるまで
-- 何度でも選び直せる形にした（この関数はもともと pending / working / no_change の行き来を許している）。
-- 🚨 ただし出勤のお願いを送ったあとは選び直せない。現行シフトで対応や未調整に戻すと、
--    パートの返事の画面が「現在調整中です」のまま残るため（ユーザー確定）。
--    画面でも止めているが、最終判定はここ（画面だけに入れると、押せば通る穴になる）。
-- 🚨 本番の実定義（pg_get_functiondef・2026-09-14）から起こし、断る条件を1つ足しただけ。
--    ほかの行は変えていない。引数も戻り値も同じなので create or replace のみ（実行権限はそのまま）。

CREATE OR REPLACE FUNCTION public.shift_adjust_set_status(p_slot_id uuid, p_status text)
 RETURNS TABLE(ok boolean, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- 🚨 2026-09-14：出勤のお願いを送った場は、状態を変えさせない（同じ状態への押し直しは通す）。
  --    変えると、パートの返事の画面が「現在調整中です」のまま残る
  if v_slot.status is distinct from p_status
     and exists (select 1 from shift_adjust_part_requests r where r.slot_id = p_slot_id) then
    return query select false, '出勤のお願いを送ったため、選び直せません。決定するか、お願いの返事を待ってください'::text;
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
