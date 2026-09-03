-- ============================================================
-- 場所予約：「この回はキャンセル待ちの対象外」をサーバーでも止める
--            （2026-09-03 実機指摘の修正）
--
-- 症状：一覧に「この回は対象外」と出るのに、「この日に入れる」で繰り上げできた。
-- 原因：no_waitlist を**画面にしか実装していなかった**（20260903171018 は列の追加だけ）。
--   繰り上げ・空き枠化のRPCは no_waitlist を見ていないので、押せば通ってしまう。
--   🚨 「入れられるかどうかの最終判定は必ずサーバー」（この機能の一貫した方針）を
--      自分で破っていた。画面の表示だけで止めない。
--
-- 直し方：両RPCの入口で no_waitlist を見て、対象外なら理由を出して断る。
--   引数は変えないので **create or replace のみ**（drop 不要＝PGRST203 の心配なし）。
--
-- ロールバック手順:
--   20260903153733 の room_vacate_to_open と
--   20260903144032 の room_promote_waitlist_at を流し直す
-- ============================================================

create or replace function room_promote_waitlist_at(
  p_waitlist_id       uuid,
  p_target_booking_id uuid,
  p_starts_at         timestamptz default null,
  p_ends_at           timestamptz default null
)
returns table (ok boolean, reason text, booking_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_w      room_waitlist;
  v_t      room_bookings;
  v_res    record;
  v_starts timestamptz;
  v_ends   timestamptz;
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

  -- ★ この回はキャンセル待ちの対象外（2026-09-03 実機指摘で追加）
  if v_t.no_waitlist then
    return query select false, 'この回はキャンセル待ちの対象外に設定されています。予約の詳細で設定を外してください', null::uuid;
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

  v_starts := coalesce(p_starts_at, v_t.starts_at);
  v_ends   := coalesce(p_ends_at,   v_t.ends_at);
  if v_ends <= v_starts then
    return query select false, '終了は開始より後にしてください', null::uuid;
    return;
  end if;

  if v_t.kind = 'open' and v_t.deleted_at is null then
    return query select false, 'この回は募集中の枠です。予約の詳細の「この枠に申込を入れる」から埋めてください', null::uuid;
    return;
  end if;

  if v_t.status = 'active' and v_t.deleted_at is null
     and not room_booking_all_absent(v_t.id) then
    return query select false, 'この回はまだ埋まっています（出席予定の方がいます）。先に休講または取り消すか、空き扱いの出欠（休みなど）を付けてください', null::uuid;
    return;
  end if;

  if room_staff_busy(coalesce(v_w.staff_id, v_t.staff_id), v_starts, v_ends, v_t.id) then
    return query select false, 'この時間の担当には、すでに別の予約が入っています（繰り上げ済みなど）。空き状況を確かめてください', null::uuid;
    return;
  end if;

  if v_t.status = 'active' and v_t.deleted_at is null then
    update room_bookings
       set status = 'cancelled', cancel_kind = 'absence',
           updated_at = now(), updated_by = auth.uid()
     where id = v_t.id;
  end if;

  select * into v_res from room_create_booking(
    v_t.floor_id,
    v_starts,
    v_ends,
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

revoke execute on function room_promote_waitlist_at(uuid, uuid, timestamptz, timestamptz) from public;
revoke execute on function room_promote_waitlist_at(uuid, uuid, timestamptz, timestamptz) from anon;
grant  execute on function room_promote_waitlist_at(uuid, uuid, timestamptz, timestamptz) to authenticated;
grant  execute on function room_promote_waitlist_at(uuid, uuid, timestamptz, timestamptz) to service_role;

-- ------------------------------------------------------------
-- 空き枠化も同じく対象外なら断る
-- ------------------------------------------------------------
create or replace function room_vacate_to_open(
  p_booking_id uuid,
  p_starts_at  timestamptz default null,
  p_ends_at    timestamptz default null
)
returns table (ok boolean, reason text, booking_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_t      room_bookings;
  v_res    record;
  v_starts timestamptz;
  v_ends   timestamptz;
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

  -- ★ この回はキャンセル待ちの対象外（2026-09-03 実機指摘で追加）
  if v_t.no_waitlist then
    return query select false, 'この回はキャンセル待ちの対象外に設定されています。予約の詳細で設定を外してください', null::uuid;
    return;
  end if;

  v_starts := coalesce(p_starts_at, v_t.starts_at);
  v_ends   := coalesce(p_ends_at,   v_t.ends_at);
  if v_ends <= v_starts then
    return query select false, '終了は開始より後にしてください', null::uuid;
    return;
  end if;

  if room_staff_busy(v_t.staff_id, v_starts, v_ends, v_t.id) then
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
    v_starts,
    v_ends,
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

revoke execute on function room_vacate_to_open(uuid, timestamptz, timestamptz) from public;
revoke execute on function room_vacate_to_open(uuid, timestamptz, timestamptz) from anon;
grant  execute on function room_vacate_to_open(uuid, timestamptz, timestamptz) to authenticated;
grant  execute on function room_vacate_to_open(uuid, timestamptz, timestamptz) to service_role;

-- 確認用:
--   select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname='public' and p.proname in ('room_promote_waitlist_at','room_vacate_to_open');
