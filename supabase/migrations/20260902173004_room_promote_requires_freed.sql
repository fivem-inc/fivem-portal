-- ============================================================
-- 場所予約：空きの無い回への繰り上げを止める（2026-09-02 実機検証で発覚）
--
-- 症状：出席予定の方がいる回（2名のうち1名が出席）に、キャンセル待ちを
--       繰り上げできてしまった。
-- 原因：担当の重なり判定が「入れ先の回そのもの」を除外している。
--       除外は「その回がこれから空く（お休みになる）」前提だったが、
--       空かない回でも除外だけが効いて素通りしていた。
--       （場所の上限は同時3件なので、そちらでも止まらない）
--
-- 直し方：繰り上げは「その回が本当に空く場合」だけ通す。
--   空く ＝ 休講・お休み（cancelled）／取消済み（deleted）／
--          全員に空き扱いの出欠が付いている（room_booking_all_absent）
--   それ以外は「まだ埋まっています」と理由を出して止める。
--   募集中の枠（kind='open'）への繰り上げも止める（申込で埋めるのが正しい）。
--
-- 画面の変更なし。日付選びの表示（occLabel）はもともと同じ判定。
--
-- ロールバック手順:
--   20260902164727 の room_promote_waitlist_at を流し直す
-- ============================================================

create or replace function room_promote_waitlist_at(
  p_waitlist_id       uuid,
  p_target_booking_id uuid
)
returns table (ok boolean, reason text, booking_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_w   room_waitlist;
  v_t   room_bookings;
  v_res record;
begin
  if auth.uid() is null then
    return query select false, 'ログインし直してください', null::uuid;
    return;
  end if;

  select * into v_w from room_waitlist where id = p_waitlist_id;
  if not found then
    return query select false, 'キャンセル待ちが見つかりませんでした', null::uuid;
    return;
  end if;
  if v_w.status <> 'waiting' then
    return query select false, 'このキャンセル待ちは、すでに処理されています', null::uuid;
    return;
  end if;

  select * into v_t from room_bookings where id = p_target_booking_id;
  if not found then
    return query select false, '入れる先の回が見つかりませんでした', null::uuid;
    return;
  end if;

  if v_w.recurrence_id is not null then
    if v_t.recurrence_id is distinct from v_w.recurrence_id then
      return query select false, 'この待ちは別の枠のものです。枠の一覧から選び直してください', null::uuid;
      return;
    end if;
  else
    if v_t.id <> v_w.booking_id then
      return query select false, 'この待ちは別の予約のものです', null::uuid;
      return;
    end if;
  end if;

  -- ★ 募集中の枠には繰り上げで入れない（申込で埋めるのが正しい・2026-09-02）
  if v_t.kind = 'open' and v_t.deleted_at is null then
    return query select false, 'この回は募集中の枠です。予約の詳細の「この枠に申込を入れる」から埋めてください', null::uuid;
    return;
  end if;

  -- ★ その回が本当に空く場合だけ通す（2026-09-02）。
  --    出席予定の方がいる回に割り込めてしまうのを防ぐ
  if v_t.status = 'active' and v_t.deleted_at is null
     and not room_booking_all_absent(v_t.id) then
    return query select false, 'この回はまだ埋まっています（出席予定の方がいます）。先に休講または取り消すか、空き扱いの出欠（休みなど）を付けてください', null::uuid;
    return;
  end if;

  -- 担当の重なり（繰り上げ済みの別予約など）。入れ先の回そのものは除く
  if room_staff_busy(coalesce(v_w.staff_id, v_t.staff_id), v_t.starts_at, v_t.ends_at, v_t.id) then
    return query select false, 'この時間の担当には、すでに別の予約が入っています（繰り上げ済みなど）。空き状況を確かめてください', null::uuid;
    return;
  end if;

  -- 空き扱いの出欠で空く回なら、自動で「お休み」にして枠を空ける
  if v_t.status = 'active' and v_t.deleted_at is null then
    update room_bookings
       set status = 'cancelled', cancel_kind = 'absence',
           updated_at = now(), updated_by = auth.uid()
     where id = v_t.id;
  end if;

  select * into v_res from room_create_booking(
    v_t.floor_id,
    v_t.starts_at,
    v_t.ends_at,
    v_t.purpose,
    v_t.booker_name,
    v_w.member_no,
    v_w.customer_label,
    v_w.note,
    v_t.exclusive,
    null,
    coalesce(v_w.staff_id, v_t.staff_id),
    'booking',
    1
  );

  if not coalesce(v_res.ok, false) then
    return query select false, coalesce(v_res.reason, '予約を作れませんでした'), null::uuid;
    return;
  end if;

  update room_waitlist
     set status = 'promoted',
         promoted_booking_id = v_res.booking_id,
         updated_at = now()
   where id = p_waitlist_id;

  return query select true, null::text, v_res.booking_id;
end;
$$;

revoke execute on function room_promote_waitlist_at(uuid, uuid) from public;
revoke execute on function room_promote_waitlist_at(uuid, uuid) from anon;
grant  execute on function room_promote_waitlist_at(uuid, uuid) to authenticated;
grant  execute on function room_promote_waitlist_at(uuid, uuid) to service_role;
