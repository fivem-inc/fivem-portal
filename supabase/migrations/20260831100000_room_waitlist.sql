-- ============================================================
-- 場所予約：キャンセル待ち（2026-08-31 ユーザー確定・案A）
--
-- 何をするものか:
--   埋まっている予約に対して「空いたら入りたい方」を並べておく。
--   休講や取り消しが出たときに、スタッフが順番を見て繰り上げる。
--
-- 募集枠（kind='open'）との違い:
--   募集枠 … まだ埋まっていない枠を先に置くもの（空きがある）
--   キャンセル待ち … 埋まっている予約の後ろに並ぶもの（空きがない）
--   別物なので、同じ表には入れない。
--   🚨 予約と同じ表に入れるとタイムラインに描かれ、「埋まっている」ように
--      見えてしまう。空き状況を誤らせるので必ず別テーブルにする。
--
-- 🚨 自動では繰り上げない（ユーザー確定）。
--    本人に確かめないまま予約が入るのを防ぐため、必ず人が押す。
--    繰り上げは room_promote_waitlist が行い、予約の作成は既存の
--    room_create_booking を通す（重なりの判定を作り直さない）。
--
-- 🚨 通知は作らない。
--    docs/開発ルール.md のとおり、新しい通知は「設定が無い＝全員に送る」作りで
--    スタッフ46人にいきなり飛ぶ。必要になったら並行開発者に相談してから。
--    いまは画面に出すだけにする。
--
-- 権限:
--   予約そのものと同じ扱い＝ログインしていれば全員が読み書きできる。
--   キャンセル待ちの受け付けは、その場に居るスタッフが行うため。
--
-- ロールバック手順:
--   drop function if exists room_promote_waitlist(uuid);
--   drop table if exists room_waitlist;
-- ============================================================

create table if not exists room_waitlist (
  id             uuid primary key default gen_random_uuid(),
  -- どの予約の後ろに並んでいるか
  booking_id     uuid not null references room_bookings(id) on delete cascade,
  member_no      text,
  customer_label text not null,
  -- 希望の担当（任意）。決まっていないことも多いので必須にしない
  staff_id       uuid references room_staff(id) on delete set null,
  note           text,
  -- 並び順。小さいほど先。同じ値のときは受け付けた順
  position       int  not null default 0,
  status         text not null default 'waiting'
                   check (status in ('waiting', 'promoted', 'cancelled')),
  -- 繰り上げてできた予約。あとから追える
  promoted_booking_id uuid references room_bookings(id) on delete set null,
  created_by     uuid not null references auth.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists idx_room_waitlist_booking
  on room_waitlist (booking_id) where status = 'waiting';

alter table room_waitlist enable row level security;

drop policy if exists room_waitlist_all on room_waitlist;
create policy room_waitlist_all on room_waitlist
  for all to authenticated using (true) with check (true);

-- ------------------------------------------------------------
-- 繰り上げ（待っている方を実際の予約にする）
--
--   もとの予約と同じ場所・同じ時間で予約を作る。
--   🚨 入るかどうかの判定は作り直さず room_create_booking に任せる。
--      もとの予約がまだ生きていて空きが無ければ、そのまま弾かれる
--      （＝休講や取り消しをしてから繰り上げる、という順番になる）。
-- ------------------------------------------------------------
create or replace function room_promote_waitlist(p_waitlist_id uuid)
returns table (ok boolean, reason text, booking_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_w   room_waitlist;
  v_b   room_bookings;
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

  select * into v_b from room_bookings where id = v_w.booking_id;
  if not found then
    return query select false, 'もとの予約が見つかりませんでした', null::uuid;
    return;
  end if;

  select * into v_res from room_create_booking(
    v_b.floor_id,
    v_b.starts_at,
    v_b.ends_at,
    v_b.purpose,
    v_b.booker_name,
    v_w.member_no,
    v_w.customer_label,
    v_w.note,
    v_b.exclusive,
    null,                                   -- 繰り返しには結び付けない（この回だけ）
    coalesce(v_w.staff_id, v_b.staff_id),
    'booking',
    1
  );

  if not coalesce(v_res.ok, false) then
    -- 🚨 入らない理由をそのまま返す。多くは「もとの予約がまだ生きている」
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
