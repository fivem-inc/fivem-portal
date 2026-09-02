-- ============================================================
-- 場所予約：「お休み（お客様都合）」と「休講（当社都合）」を分ける
--            （2026-09-02 ユーザー指示・呼び名は案A「お休み」で確定）
--
-- きっかけ：繰り上げの自動処理で元の回が「休講」になり、
--   「休講なので出欠はありません」と出て**休みの記録が見えなくなった**。
--
-- 作り：status は今までどおり 'cancelled' を使い（＝予約数に数えない・
--   空き判定から外れる動きはそのまま）、**取り消しの種類**を列で分ける。
--     cancel_kind = 'closed'  … 休講（当社都合。レッスン自体を開催しない）
--     cancel_kind = 'absence' … お休み（お客様都合のキャンセル）
--   お休みの回は、出欠（休み・キャンセル料）が**見えたまま・直せたまま**になり、
--   出欠の集計にも含まれる（キャン1回消化などの回数消化が照合から漏れないように）。
--
-- 🚨 既定は 'closed'。既存の休講はすべて「休講」のまま変わらない。
-- 🚨 自動処理（繰り上げ・空き枠化）だけが 'absence' を付ける。
--    手動の「休講にする」は今までどおり 'closed'。
--
-- ロールバック手順:
--   20260902154706 の2関数を流し直す;
--   alter table room_bookings drop column if exists cancel_kind;
-- ============================================================

alter table room_bookings
  add column if not exists cancel_kind text not null default 'closed'
    check (cancel_kind in ('closed', 'absence'));

-- ------------------------------------------------------------
-- 繰り上げ：自動の取り消しを「お休み」種別にする
-- （本体は 20260902154706 と同じ。update に cancel_kind を足しただけ）
-- ------------------------------------------------------------
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

  -- 空き扱いの出欠が全員に付いた回なら、自動で「お休み」にして枠を空ける
  if v_t.status = 'active' and v_t.deleted_at is null and v_t.kind = 'booking'
     and room_booking_all_absent(v_t.id) then
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

-- ------------------------------------------------------------
-- 空き枠化：自動の取り消しを「お休み」種別にする
-- ------------------------------------------------------------
create or replace function room_vacate_to_open(p_booking_id uuid)
returns table (ok boolean, reason text, booking_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_t   room_bookings;
  v_res record;
begin
  if auth.uid() is null then
    return query select false, 'ログインし直してください', null::uuid;
    return;
  end if;

  select * into v_t from room_bookings where id = p_booking_id;
  if not found or v_t.deleted_at is not null then
    return query select false, 'この回が見つかりませんでした', null::uuid;
    return;
  end if;
  if v_t.kind <> 'booking' then
    return query select false, 'この回はすでに募集中の枠です', null::uuid;
    return;
  end if;

  if v_t.status = 'active' then
    if not room_booking_all_absent(v_t.id) then
      return query select false, '空き扱いの出欠（休みなど）が全員に付いていないため、空き枠にできません', null::uuid;
      return;
    end if;
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
    null,
    null,
    null,
    false,
    null,
    v_t.staff_id,
    'open',
    1
  );

  if not coalesce(v_res.ok, false) then
    return query select false, coalesce(v_res.reason, '空き枠を作れませんでした'), null::uuid;
    return;
  end if;

  return query select true, null::text, v_res.booking_id;
end;
$$;

revoke execute on function room_vacate_to_open(uuid) from public;
revoke execute on function room_vacate_to_open(uuid) from anon;
grant  execute on function room_vacate_to_open(uuid) to authenticated;
grant  execute on function room_vacate_to_open(uuid) to service_role;

-- 今日の検証で「休講」になってしまった 9/1 の太田 華鈴の回を「お休み」に直す
--（繰り上げの自動処理が付けるはずだった種別。実データ1件のみ・実行前に select で確認）
--   select id, customer_label, status, cancel_kind from room_bookings
--    where id = 'f84a597c-fcc5-4df1-b48c-0cd95a7cc908';
update room_bookings
   set cancel_kind = 'absence'
 where id = 'f84a597c-fcc5-4df1-b48c-0cd95a7cc908'
   and status = 'cancelled';

-- 確認用:
--   select column_name from information_schema.columns
--    where table_name = 'room_bookings' and column_name = 'cancel_kind';
