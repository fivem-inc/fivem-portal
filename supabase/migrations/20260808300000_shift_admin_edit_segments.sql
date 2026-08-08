-- 管理者の勤務変更修正モーダルを「時間帯」方式（最大3つ・行ごとの勤務地）に揃える。
-- admin_edit_shift_report に p_actual_segments (jsonb) を追加。
--
-- 🚨 create or replace は引数が違うと「置き換え」ではなく「別関数の追加」になる
--    （edit_own_leave・submit_safety_response で2回踏んだ）。旧14引数版を必ず drop する。

drop function if exists public.admin_edit_shift_report(
  uuid, text[], date, text,
  time without time zone, time without time zone,
  time without time zone, time without time zone,
  integer, integer, text, jsonb, text, text
);

create or replace function public.admin_edit_shift_report(
  p_id                  uuid,
  p_application_types   text[],
  p_work_date           date,
  p_actual_location     text,
  p_actual_start        time without time zone,
  p_actual_end          time without time zone,
  p_actual_outing_start time without time zone,
  p_actual_outing_end   time without time zone,
  p_break_minutes       integer,
  p_labor_minutes       integer,
  p_reason              text,
  p_changes             jsonb,
  p_change_summary      text,
  p_change_reason       text,
  -- 🚨 default null にして、まだ更新されていない旧クライアント（p_actual_segments を渡さない）
  --    からの呼び出しも壊れないようにする（旧クライアントは保存後に actual_segments を null にするため整合する）
  p_actual_segments     jsonb default null
)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_snapshot jsonb;
begin
  if (auth.jwt() -> 'app_metadata' ->> 'role') <> 'admin' then
    raise exception 'permission denied: admin only' using errcode = '42501';
  end if;

  -- 時間帯は最大3つ（本人の報告画面・DBの持ち方と同じ制限）
  if p_actual_segments is not null and jsonb_typeof(p_actual_segments) <> 'array' then
    raise exception 'p_actual_segments must be a jsonb array' using errcode = '22023';
  end if;
  if p_actual_segments is not null and jsonb_array_length(p_actual_segments) > 3 then
    raise exception 'p_actual_segments: too many segments (max 3)' using errcode = '22023';
  end if;

  select to_jsonb(sr.*) into v_snapshot from shift_reports sr where sr.id = p_id;
  if v_snapshot is null then
    raise exception 'shift_report not found: %', p_id using errcode = 'P0002';
  end if;

  update shift_reports set
    application_types    = p_application_types,
    application_type     = coalesce(p_application_types[1], application_type),
    work_date            = p_work_date,
    actual_location      = p_actual_location,
    actual_start         = p_actual_start,
    actual_end           = p_actual_end,
    actual_outing_start  = p_actual_outing_start,
    actual_outing_end    = p_actual_outing_end,
    actual_segments      = p_actual_segments,
    break_minutes        = p_break_minutes,
    labor_minutes        = p_labor_minutes,
    reason               = p_reason,
    updated_at           = now()
  where id = p_id;

  insert into shift_report_history
    (report_id, changed_by, change_kind, change_summary, change_reason, changes, snapshot)
  values
    (p_id, auth.uid(), 'admin_edit', p_change_summary, p_change_reason, p_changes, v_snapshot);
end;
$$;
