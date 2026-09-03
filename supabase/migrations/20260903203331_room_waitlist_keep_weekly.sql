-- ============================================================
-- 場所予約：毎週の枠のキャンセル待ちは、繰り上げても残す
--            （2026-09-03 ユーザー承認・案A）
--
-- 症状：毎週の枠でも、1回繰り上げると待ちが promoted になって**消えていた**。
--   実際は「今回は入れた。来週以降も空いたら入りたい」が普通なので、
--   他の週のために待ち行列に残す必要がある。
--
-- 直し方：
--   ・**毎週の枠の待ち（recurrence_id あり）** … 繰り上げても status は 'waiting' のまま。
--     「最後にどの回へ入ったか」を last_promoted_booking_id / last_promoted_at に残す。
--     順番（position）もそのまま。もう待たないときは人が「取り消す」で終える
--   ・**この回だけの待ち（booking_id あり）** … 従来どおり promoted にして終了
--     （特定の1日を狙ったものなので、入った時点で役目が終わる）
--
-- 🚨 同じ回に二重で入れないよう、その待ちが**すでにその回へ繰り上げ済みなら断る**
--    （画面でもボタンを押せなくするが、最終判定はサーバー）。
-- 🚨 引数は変えないので create or replace のみ（drop 不要＝PGRST203 の心配なし）。
--
-- ロールバック手順:
--   20260903201024 の room_promote_waitlist_at を流し直す;
--   drop table if exists room_waitlist_promotions;
--   alter table room_waitlist drop column if exists last_promoted_booking_id;
--   alter table room_waitlist drop column if exists last_promoted_at;
-- ============================================================

alter table room_waitlist
  add column if not exists last_promoted_booking_id uuid references room_bookings(id) on delete set null;
alter table room_waitlist
  add column if not exists last_promoted_at timestamptz;

-- どの待ちが、どの回に入ったかの記録（二重繰り上げの判定に使う）
create table if not exists room_waitlist_promotions (
  id          uuid primary key default gen_random_uuid(),
  waitlist_id uuid not null references room_waitlist(id) on delete cascade,
  booking_id  uuid not null references room_bookings(id) on delete cascade,
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id)
);

-- 🚨 同じ待ちが同じ回に二重に入らないようにする（DB側の最後の砦）
create unique index if not exists idx_room_waitlist_promotions_uniq
  on room_waitlist_promotions (waitlist_id, booking_id);

alter table room_waitlist_promotions enable row level security;

-- 読みはログイン者全員（一覧で「◯/◯に繰り上げ済み」を出す）
drop policy if exists room_waitlist_promotions_select on room_waitlist_promotions;
create policy room_waitlist_promotions_select on room_waitlist_promotions
  for select to authenticated using (true);

-- 書きはパート以外（待ちの操作と同じ条件）。実際の insert は RPC が行う
drop policy if exists room_waitlist_promotions_write on room_waitlist_promotions;
create policy room_waitlist_promotions_write on room_waitlist_promotions
  for all to authenticated
  using (room_is_staff())
  with check (room_is_staff());

-- ------------------------------------------------------------
-- 繰り上げ：毎週の枠の待ちは残す
-- ------------------------------------------------------------
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

  if v_t.no_waitlist then
    return query select false, 'この回はキャンセル待ちの対象外に設定されています。予約の詳細で設定を外してください', null::uuid;
    return;
  end if;

  -- ★ 同じ回への二重繰り上げを断る（2026-09-03。毎週の待ちは残るので起こり得る）
  if exists (select 1 from room_waitlist_promotions
              where waitlist_id = v_w.id and booking_id = v_t.id) then
    return query select false, 'この方は、この回にはすでに繰り上げ済みです', null::uuid;
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

  -- どの回に入ったかを記録（二重繰り上げの判定と、一覧の「◯/◯に繰り上げ済み」に使う）
  insert into room_waitlist_promotions (waitlist_id, booking_id, created_by)
  values (v_w.id, v_t.id, auth.uid())
  on conflict (waitlist_id, booking_id) do nothing;

  if v_w.recurrence_id is not null then
    -- ★ 毎週の枠の待ちは**残す**（他の週のために待ち続ける・2026-09-03 ユーザー承認）
    update room_waitlist
       set last_promoted_booking_id = v_res.booking_id,
           last_promoted_at = now(),
           updated_at = now()
     where id = p_waitlist_id;
  else
    -- この回だけの待ちは、入った時点で役目が終わる（従来どおり）
    update room_waitlist
       set status = 'promoted',
           promoted_booking_id = v_res.booking_id,
           last_promoted_booking_id = v_res.booking_id,
           last_promoted_at = now(),
           updated_at = now()
     where id = p_waitlist_id;
  end if;

  return query select true, null::text, v_res.booking_id;
end;
$$;

revoke execute on function room_promote_waitlist_at(uuid, uuid, timestamptz, timestamptz) from public;
revoke execute on function room_promote_waitlist_at(uuid, uuid, timestamptz, timestamptz) from anon;
grant  execute on function room_promote_waitlist_at(uuid, uuid, timestamptz, timestamptz) to authenticated;
grant  execute on function room_promote_waitlist_at(uuid, uuid, timestamptz, timestamptz) to service_role;

-- 確認用:
--   select column_name from information_schema.columns
--    where table_name='room_waitlist' and column_name in ('last_promoted_booking_id','last_promoted_at');
--   select pg_get_functiondef(p.oid) like '%room_waitlist_promotions%' as has_log
--     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--    where n.nspname='public' and p.proname='room_promote_waitlist_at';
