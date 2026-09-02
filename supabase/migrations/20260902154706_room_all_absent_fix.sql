-- ============================================================
-- 場所予約：空き扱い判定の修正（2026-09-02 実機検証で発覚）
--
-- 症状：休みを付けた回を繰り上げても、その回が自動で休講にならなかった。
-- 原因：判定が「その予約の出欠の**行の全部**が空き扱いか」だったため、
--       過去のテストで残った**キーの違う古い出欠の行**（迷子の行）が
--       1つあるだけで発動しなくなっていた（実データで att_total=2/att_open=1）。
--
-- 直し方：「**いまの参加者それぞれ**に空き扱いの出欠が付いているか」で見る。
--   ・参加者は customer_label（無ければ member_no）をカンマで分けたもの
--   ・迷子の行（いまの参加者に当たらない行）は無視する
--   ・参加者に一致する行に空き扱い**でない**ものがあれば不成立
--
-- 🚨 判定は room_booking_all_absent() の1か所にまとめ、
--    繰り上げ（room_promote_waitlist_at）と空き枠化（room_vacate_to_open）の
--    両方がこれを呼ぶ。同じ判定を2か所に書かない。
--    （画面側にも同等の判定があるが、これはクライアント/サーバーの分担上
--      避けられない。両方を直すこと＝この migration とセットのコミット）
--
-- 対象の3関数はすべて当方が本日作成したもの（他所からの変更なし）。
--
-- ロールバック手順:
--   20260902144945 と 20260902150158 の関数を流し直す;
--   drop function if exists room_booking_all_absent(uuid);
-- ============================================================

create or replace function room_booking_all_absent(p_booking_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_t     room_bookings;
  v_open  text[];
  v_names text[];
  v_nos   text[];
  v_key   text;
begin
  select * into v_t from room_bookings where id = p_booking_id;
  if not found then return false; end if;

  select coalesce(array_agg(btrim(x)), '{}') into v_open
    from unnest(string_to_array(
      coalesce((select value from room_settings where key = 'waitlist_open_statuses'),
               '休み,キャンセル料'), ',')) x
   where btrim(x) <> '';
  -- 設定を空にしてある（連動を止めている）ときは常に不成立
  if coalesce(array_length(v_open, 1), 0) = 0 then return false; end if;

  select coalesce(array_agg(btrim(s)), '{}') into v_names
    from unnest(string_to_array(coalesce(v_t.customer_label, ''), ',')) s
   where btrim(s) <> '';
  select coalesce(array_agg(btrim(s)), '{}') into v_nos
    from unnest(string_to_array(coalesce(v_t.member_no, ''), ',')) s
   where btrim(s) <> '';

  if coalesce(array_length(v_names, 1), 0) > 0 then
    -- お名前を鍵に、参加者1人ずつ確かめる
    foreach v_key in array v_names loop
      if not exists (select 1 from room_booking_attendance a
                      where a.booking_id = v_t.id
                        and btrim(a.participant_name) = v_key
                        and btrim(a.status) = any (v_open)) then
        return false;
      end if;
      if exists (select 1 from room_booking_attendance a
                  where a.booking_id = v_t.id
                    and btrim(a.participant_name) = v_key
                    and not (btrim(a.status) = any (v_open))) then
        return false;
      end if;
    end loop;
    return true;
  elsif coalesce(array_length(v_nos, 1), 0) > 0 then
    -- お名前が無い予約（会員番号だけ）は番号を鍵にする
    foreach v_key in array v_nos loop
      if not exists (select 1 from room_booking_attendance a
                      where a.booking_id = v_t.id
                        and btrim(a.participant_no) = v_key
                        and btrim(a.status) = any (v_open)) then
        return false;
      end if;
      if exists (select 1 from room_booking_attendance a
                  where a.booking_id = v_t.id
                    and btrim(a.participant_no) = v_key
                    and not (btrim(a.status) = any (v_open))) then
        return false;
      end if;
    end loop;
    return true;
  end if;

  return false;   -- 参加者が読み取れない予約は空き扱いにしない
end;
$$;

revoke execute on function room_booking_all_absent(uuid) from public;
revoke execute on function room_booking_all_absent(uuid) from anon;
grant  execute on function room_booking_all_absent(uuid) to authenticated;
grant  execute on function room_booking_all_absent(uuid) to service_role;

-- ------------------------------------------------------------
-- 繰り上げ：判定を共通関数に差し替え
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

  -- 空き扱いの出欠が全員に付いた回なら、自動で休講にして枠を空ける
  if v_t.status = 'active' and v_t.deleted_at is null and v_t.kind = 'booking'
     and room_booking_all_absent(v_t.id) then
    update room_bookings
       set status = 'cancelled', updated_at = now(), updated_by = auth.uid()
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
-- 空き枠化：判定を共通関数に差し替え
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
       set status = 'cancelled', updated_at = now(), updated_by = auth.uid()
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

-- 確認用（9/1 の実データで判定が true になるか）:
--   select id, customer_label, room_booking_all_absent(id)
--     from room_bookings
--    where starts_at >= '2026-09-01 00:00+09' and starts_at < '2026-09-02 00:00+09'
--      and deleted_at is null and kind = 'booking';
