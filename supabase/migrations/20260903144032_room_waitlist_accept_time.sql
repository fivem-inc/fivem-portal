-- ============================================================
-- 場所予約：キャンセル待ちの「受け入れ時間」（2026-09-03 ユーザー承認）
--
-- 背景：枠によって「キャンセル待ちで受けるなら何時から」という決まりがある。
--   待ちごとに**受け入れ時間（開始・終了）を予め持たせ**、繰り上げのとき
--   その時間で予約を作れるようにする。
--   ・accept_start / accept_end が null ＝ 枠の時間のまま（今までどおり）
--   ・繰り上げの確認パネルに既定値として入り、その場の微調整もできる
--
-- 繰り上げ関数に時間の引数（p_starts_at / p_ends_at・省略可）を追加する。
-- 🚨 既存の2引数版は **drop してから** 4引数版を作る。
--    残すと同名の関数が2つになり、PostgREST が「どちらか分からない」
--    （PGRST203）で**繰り上げ自体が全部失敗する**ため。
--    この関数は当方が本日までに作ったもので、呼び出し元は画面の1か所だけ。
-- 🚨 空きの判定（担当の重なり）は**新しい時間で**行う。
-- 🚨 用途の長さ制限は掛けない（受け入れ時の例外対応が目的・ユーザー確定）。
--
-- ロールバック手順:
--   drop function if exists room_promote_waitlist_at(uuid, uuid, timestamptz, timestamptz);
--   20260902173004 の room_promote_waitlist_at を流し直す;
--   alter table room_waitlist drop column if exists accept_start;
--   alter table room_waitlist drop column if exists accept_end;
-- ============================================================

alter table room_waitlist add column if not exists accept_start time;
alter table room_waitlist add column if not exists accept_end   time;

drop function if exists room_promote_waitlist_at(uuid, uuid);

create function room_promote_waitlist_at(
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

  -- 受け入れ時間（指定がなければ枠の時間のまま）
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

  -- 担当の重なりは**受け入れ時間**で見る（時間をずらした先の別予約とぶつからないように）
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

-- 確認用:
--   select column_name from information_schema.columns
--    where table_name = 'room_waitlist' and column_name in ('accept_start', 'accept_end');
--   select p.proname, pg_get_function_identity_arguments(p.oid)
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'room_promote_waitlist_at';
