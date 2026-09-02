-- ============================================================
-- 場所予約：繰り上げの二重詰め込みを防ぐ（2026-09-02 実機検証で発覚）
--
-- 症状：1名の「お休み」で空いた枠に、キャンセル待ちから**2名**繰り上げできた。
-- 原因：予約作成の判定は**場所の上限（同時3件）しか見ていない**ため、
--       担当が同じでも上限に収まれば通ってしまう。
--       1人目の繰り上げで担当の枠は埋まったのに、2人目も作れた。
--
-- 直し方：繰り上げ（room_promote_waitlist_at）と空き枠化（room_vacate_to_open）に
--   **担当スタッフの時間の重なり**の判定を足す。重なっていれば理由を出して拒否。
--   🚨 room_create_booking（中心の関数）には手を入れない。
--      手入力の予約は今までどおり「黄色い警告のみ・止めない」（2026-09-01 ユーザー確定）。
--      繰り上げは1タップで中身を見ずに作るので、こちらは止める、という整理。
--   🚨 担当なしの枠は判定できないので、今までどおり場所の上限だけで見る。
--
-- ロールバック手順:
--   20260902163127 の2関数を流し直す;
--   drop function if exists room_staff_busy(uuid, timestamptz, timestamptz, uuid);
-- ============================================================

-- その担当に、指定の時間と重なる生きた予約があるか。
-- p_exclude は「これから空ける元の回」を除くため（自分自身と重なる、を避ける）。
-- 🚨 境目（18:00終了と18:00開始）は重なりとしない（< と > の向きに注意）
create or replace function room_staff_busy(
  p_staff_id uuid,
  p_starts   timestamptz,
  p_ends     timestamptz,
  p_exclude  uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_staff_id is not null and exists (
    select 1 from room_bookings b
     where b.staff_id = p_staff_id
       and b.id <> p_exclude
       and b.deleted_at is null
       and b.status = 'active'
       and b.kind = 'booking'
       and b.starts_at < p_ends
       and p_starts < b.ends_at
  );
$$;

revoke execute on function room_staff_busy(uuid, timestamptz, timestamptz, uuid) from public;
revoke execute on function room_staff_busy(uuid, timestamptz, timestamptz, uuid) from anon;
grant  execute on function room_staff_busy(uuid, timestamptz, timestamptz, uuid) to authenticated;
grant  execute on function room_staff_busy(uuid, timestamptz, timestamptz, uuid) to service_role;

-- ------------------------------------------------------------
-- 繰り上げ：担当の重なりを判定に追加
-- （本体は 20260902163127 と同じ。判定を1つ足しただけ）
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

  -- ★ 担当の重なり。1人目の繰り上げで埋まった枠に2人目を入れない（2026-09-02）
  if room_staff_busy(coalesce(v_w.staff_id, v_t.staff_id), v_t.starts_at, v_t.ends_at, v_t.id) then
    return query select false, 'この時間の担当には、すでに別の予約が入っています（繰り上げ済みなど）。空き状況を確かめてください', null::uuid;
    return;
  end if;

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
-- 空き枠化：担当の重なりを判定に追加
-- （繰り上げ済みなのに空き枠を作ると、無い空きを募集してしまうため）
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

  -- ★ 担当の重なり（2026-09-02）
  if room_staff_busy(v_t.staff_id, v_t.starts_at, v_t.ends_at, v_t.id) then
    return query select false, 'この時間の担当には、すでに別の予約が入っています（繰り上げ済みなど）。空き枠にはできません', null::uuid;
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

-- 確認用（9/1 17:30 の枠で、担当が埋まっている判定になるか）:
--   select room_staff_busy(
--     (select staff_id from room_bookings where id = 'f84a597c-fcc5-4df1-b48c-0cd95a7cc908'),
--     (select starts_at from room_bookings where id = 'f84a597c-fcc5-4df1-b48c-0cd95a7cc908'),
--     (select ends_at   from room_bookings where id = 'f84a597c-fcc5-4df1-b48c-0cd95a7cc908'),
--     'f84a597c-fcc5-4df1-b48c-0cd95a7cc908');
