-- ============================================================
-- 場所予約：募集中の枠（2026-08-28 ユーザー指示）
--
-- 何をするものか:
--   「毎週火曜 16:00〜16:45 はレッスンできます」のように **先に枠だけ置いておき**、
--   申込が入ったら埋める、という運用に対応する。
--   タイムラインでは予約と並べて「募集中」として見えるようにする。
--
-- 設計の判断:
--   新しいテーブルを作らず、room_bookings に kind 列を足して
--   「予約(booking)」と「募集枠(open)」を同じ表で持つ。
--     ・同じ時間軸に並べて描くので、別テーブルだと表示のたびに2本読んで混ぜることになる
--     ・場所の同時件数(capacity)の勘定に、募集枠も一緒に含めたい
--       （枠を置いた時点でその場所は押さえてある、という運用のため）
--     ・埋まったときは kind を 'open' → 'booking' に変えるだけで済む
--
--   定員(seats)は既定 1。「同時に2名で受けたい」ときだけ 2 以上にする（ユーザー確定）。
--   何人埋まったかは filled で持つ。
--   🚨 seats は「1つの枠に入れる人数」で、room_floors.capacity（場所に同時に入れられる
--      予約の件数）とは別物。混同しないこと。
--
-- ロールバック手順:
--   alter table room_bookings drop column kind, drop column seats, drop column filled;
--   alter table room_recurrences drop column kind, drop column seats;
-- ============================================================

-- 1) 予約か募集枠かの区別と、募集枠の定員
alter table room_bookings
  add column if not exists kind   text not null default 'booking'
    check (kind in ('booking', 'open')),
  add column if not exists seats  int  not null default 1 check (seats >= 1),
  add column if not exists filled int  not null default 0 check (filled >= 0);

-- 繰り返しでも募集枠を置けるようにする（毎週◯曜の空き枠を先に並べる使い方）
alter table room_recurrences
  add column if not exists kind  text not null default 'booking'
    check (kind in ('booking', 'open')),
  add column if not exists seats int  not null default 1 check (seats >= 1);

-- 募集枠だけを拾う索引（「いま募集中はどこか」を出すため）
create index if not exists idx_room_bookings_open
  on room_bookings (starts_at)
  where kind = 'open' and deleted_at is null and status = 'active';

-- ------------------------------------------------------------
-- 2) 予約を作る関数に kind / seats を足す
--    🚨 引数が増えると PostgREST から見て別関数になるため、古い定義を drop してから作る
--       （同名の2定義が残ると、どちらが呼ばれるか曖昧になる）
-- ------------------------------------------------------------
drop function if exists room_create_booking(uuid, timestamptz, timestamptz, text, text, text, text, text, boolean, uuid, uuid);

create or replace function room_create_booking(
  p_floor_id       uuid,
  p_starts_at      timestamptz,
  p_ends_at        timestamptz,
  p_purpose        text,
  p_booker_name    text,
  p_member_no      text default null,
  p_customer_label text default null,
  p_memo           text default null,
  p_exclusive      boolean default false,
  p_recurrence_id  uuid default null,
  p_staff_id       uuid default null,
  p_kind           text default 'booking',
  p_seats          int  default 1
)
returns table (ok boolean, reason text, booking_id uuid, conflicts jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok    boolean;
  v_why   text;
  v_list  jsonb;
  v_id    uuid;
begin
  if p_ends_at <= p_starts_at then
    return query select false, '終了は開始より後にしてください', null::uuid, '[]'::jsonb;
    return;
  end if;
  if p_kind not in ('booking', 'open') then
    return query select false, '種別が正しくありません', null::uuid, '[]'::jsonb;
    return;
  end if;

  -- フロア単位で直列化（同時に3件目・4件目を入れる競合を防ぐ）
  perform pg_advisory_xact_lock(hashtextextended(p_floor_id::text, 0));

  select c.ok, c.reason, c.conflicts into v_ok, v_why, v_list
  from room_check_conflict(p_floor_id, p_starts_at, p_ends_at, p_exclusive, null) c;

  if not v_ok then
    return query select false, v_why, null::uuid, v_list;
    return;
  end if;

  insert into room_bookings (
    floor_id, starts_at, ends_at, purpose, booker_name,
    member_no, customer_label, memo, exclusive, recurrence_id, staff_id,
    kind, seats, created_by
  ) values (
    p_floor_id, p_starts_at, p_ends_at, p_purpose, p_booker_name,
    nullif(p_member_no, ''), nullif(p_customer_label, ''), nullif(p_memo, ''),
    p_exclusive, p_recurrence_id, p_staff_id,
    p_kind, greatest(coalesce(p_seats, 1), 1), auth.uid()
  ) returning id into v_id;

  return query select true, null::text, v_id, '[]'::jsonb;
end $$;

-- ------------------------------------------------------------
-- 3) 変更する関数にも kind / seats を足す
-- ------------------------------------------------------------
drop function if exists room_update_booking(uuid, timestamptz, timestamptz, text, text, text, text, text, boolean, uuid);

create or replace function room_update_booking(
  p_id             uuid,
  p_starts_at      timestamptz,
  p_ends_at        timestamptz,
  p_purpose        text,
  p_booker_name    text,
  p_member_no      text default null,
  p_customer_label text default null,
  p_memo           text default null,
  p_exclusive      boolean default false,
  p_staff_id       uuid default null,
  p_kind           text default 'booking',
  p_seats          int  default 1
)
returns table (ok boolean, reason text, conflicts jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_floor uuid;
  v_ok    boolean;
  v_why   text;
  v_list  jsonb;
begin
  select floor_id into v_floor from room_bookings where id = p_id and deleted_at is null;
  if v_floor is null then
    return query select false, 'この予約は見つかりませんでした（すでに削除された可能性があります）', '[]'::jsonb;
    return;
  end if;
  if p_ends_at <= p_starts_at then
    return query select false, '終了は開始より後にしてください', '[]'::jsonb;
    return;
  end if;
  if p_kind not in ('booking', 'open') then
    return query select false, '種別が正しくありません', '[]'::jsonb;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_floor::text, 0));

  select c.ok, c.reason, c.conflicts into v_ok, v_why, v_list
  from room_check_conflict(v_floor, p_starts_at, p_ends_at, p_exclusive, p_id) c;

  if not v_ok then
    return query select false, v_why, v_list;
    return;
  end if;

  update room_bookings set
    starts_at = p_starts_at, ends_at = p_ends_at, purpose = p_purpose,
    booker_name = p_booker_name, member_no = nullif(p_member_no, ''),
    customer_label = nullif(p_customer_label, ''), memo = nullif(p_memo, ''),
    exclusive = p_exclusive, staff_id = p_staff_id,
    kind = p_kind, seats = greatest(coalesce(p_seats, 1), 1),
    updated_by = auth.uid(), updated_at = now()
  where id = p_id;

  return query select true, null::text, '[]'::jsonb;
end $$;

-- ------------------------------------------------------------
-- 4) 募集枠を「予約が入った」状態にする
--    枠を消して予約を作り直すのではなく、同じ行の kind を変えるだけにする。
--    そうすると「もともと募集枠だった」という履歴が残り、
--    枠を消した瞬間に他の人が入り込む、という取り合いも起きない。
--
--    定員(seats)が2以上のときは filled を1つ増やし、埋まりきったら kind を booking にする。
-- ------------------------------------------------------------
create or replace function room_fill_open_slot(
  p_id             uuid,
  p_member_no      text default null,
  p_customer_label text default null,
  p_memo           text default null
)
returns table (ok boolean, reason text, still_open boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_kind   text;
  v_seats  int;
  v_filled int;
  v_floor  uuid;
begin
  select kind, seats, filled, floor_id into v_kind, v_seats, v_filled, v_floor
  from room_bookings where id = p_id and deleted_at is null;

  if v_kind is null then
    return query select false, 'この枠は見つかりませんでした（すでに削除された可能性があります）', false;
    return;
  end if;
  if v_kind <> 'open' then
    return query select false, 'この枠はすでに予約が入っています', false;
    return;
  end if;

  -- 同じ枠を2人が同時に埋めようとする競合を防ぐ
  perform pg_advisory_xact_lock(hashtextextended(v_floor::text, 0));

  -- ロック後にもう一度見る（待っている間に埋まっているかもしれない）
  select kind, filled into v_kind, v_filled from room_bookings where id = p_id;
  if v_kind <> 'open' then
    return query select false, 'この枠はすでに予約が入っています', false;
    return;
  end if;

  update room_bookings set
    filled = v_filled + 1,
    -- 定員まで埋まったら「予約」に変わる。まだ空きがあれば募集中のまま
    kind = case when v_filled + 1 >= v_seats then 'booking' else 'open' end,
    -- 名前は上書きせず、すでに入っていれば「田中様, 佐藤様」とつなぐ（2名同時の申込に対応）
    member_no = case
      when nullif(p_member_no, '') is null then member_no
      when member_no is null then p_member_no
      else member_no || ', ' || p_member_no end,
    customer_label = case
      when nullif(p_customer_label, '') is null then customer_label
      when customer_label is null then p_customer_label
      else customer_label || ', ' || p_customer_label end,
    memo = case
      when nullif(p_memo, '') is null then memo
      when memo is null then p_memo
      else memo || E'\n' || p_memo end,
    updated_by = auth.uid(), updated_at = now()
  where id = p_id;

  return query select true, null::text, (v_filled + 1 < v_seats);
end $$;
