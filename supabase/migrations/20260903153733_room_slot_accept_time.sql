-- ============================================================
-- 場所予約：枠の「受け入れ時間」と、空き枠化の時間指定（2026-09-03 ユーザー承認）
--
-- 「空きが出たときの受け入れは何時から」というルールは**枠に属する**。
-- ① 毎週の枠（room_recurrences）に受け入れ時間（任意）を持たせる。
--    使われる場面（画面側）：
--      ・繰り上げの確認パネルの既定値（待ちの個別設定 → 枠の受け入れ時間 → 枠の時間）
--      ・空き枠にするときの既定値
--      ・待ちの登録で「受け入れ時間を指定する」を入れたときの初期値
-- ② 空き枠にするRPCにも時間の引数を追加（省略時は枠の時間のまま）。
--    🚨 旧1引数版は **drop してから** 3引数版を作る（残すと PGRST203 で全滅）。
--    🚨 担当の重なりは**新しい時間で**判定する。
--
-- ロールバック手順:
--   drop function if exists room_vacate_to_open(uuid, timestamptz, timestamptz);
--   20260902164727 の room_vacate_to_open を流し直す;
--   alter table room_recurrences drop column if exists accept_start;
--   alter table room_recurrences drop column if exists accept_end;
-- ============================================================

alter table room_recurrences add column if not exists accept_start time;
alter table room_recurrences add column if not exists accept_end   time;

drop function if exists room_vacate_to_open(uuid);

create function room_vacate_to_open(
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

  -- 受け入れ時間（指定がなければ枠の時間のまま）
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
--   select p.proname, pg_get_function_identity_arguments(p.oid) as args
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'room_vacate_to_open';
