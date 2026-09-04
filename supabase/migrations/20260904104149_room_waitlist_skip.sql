-- ============================================================
-- 場所予約：毎週の待ちの「この日は見送る」（2026-09-04 ユーザー承認）
--
-- 背景：毎週の枠のキャンセル待ちは、1回繰り上げても待ち行列に残る（2026-09-03〜）。
--   そのため「今週は都合が悪いので入らない。来週以降は待ち続ける」という日が出る。
--   これまでは**待ちを取り消す**しか手が無く、取り消すと順番まで失われていた。
--
-- 作り：待ち × 回 の「見送り」を記録する。**待ちのデータは消さない**。
--   その回だけ繰り上げの対象から外し、いつでも戻せる。理由は任意で残せる。
--
-- 🚨 画面とサーバーの**両方**に入れる。2026-09-03 に no_waitlist を画面にしか
--    入れず「一覧には対象外と出るのに、押せば通る」状態を作った失敗と同型のため
--    （＝入れられるかどうかの最終判定は必ずサーバー）。
-- 🚨 引数は変えないので create or replace のみ（drop 不要＝PGRST203 の心配なし）。
-- 🚨 対象は**毎週の枠の待ち**だけ。「この回だけ」の待ちは見送り＝取り消しと同じ意味に
--    なるので、画面からは付けない（DB上は制約を掛けず、将来の使い道を塞がない）。
--
-- ロールバック手順:
--   20260903203331 の room_promote_waitlist_at を流し直す;
--   drop table if exists room_waitlist_skips;
-- ============================================================

create table if not exists room_waitlist_skips (
  id          uuid primary key default gen_random_uuid(),
  waitlist_id uuid not null references room_waitlist(id) on delete cascade,
  booking_id  uuid not null references room_bookings(id) on delete cascade,
  -- 見送りの理由（任意）。例：「旅行のため」「この日は仕事」
  reason      text,
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users(id)
);

-- 🚨 同じ待ち・同じ回に二重で登録されないようにする（画面から連打されても1件）
create unique index if not exists idx_room_waitlist_skips_uniq
  on room_waitlist_skips (waitlist_id, booking_id);

alter table room_waitlist_skips enable row level security;

-- 読みはログイン者全員（一覧・日付選びで「見送り」を出す）
drop policy if exists room_waitlist_skips_select on room_waitlist_skips;
create policy room_waitlist_skips_select on room_waitlist_skips
  for select to authenticated using (true);

-- 書きはパート以外（待ちの操作と同じ条件）
drop policy if exists room_waitlist_skips_write on room_waitlist_skips;
create policy room_waitlist_skips_write on room_waitlist_skips
  for all to authenticated
  using (room_is_staff())
  with check (room_is_staff());

-- ------------------------------------------------------------
-- 繰り上げ：見送りにした回は断る
--
-- 🚨 この関数は 20260903203331 の定義に、見送りの判定（★の1か所）だけを足したもの。
--    本番の実定義（pg_get_functiondef）と突き合わせてから流すこと
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

  -- ★ この方が「この日は見送る」にしている回は入れない（2026-09-04）
  if exists (select 1 from room_waitlist_skips
              where waitlist_id = v_w.id and booking_id = v_t.id) then
    return query select false, 'この方は、この日を見送りにしています。入れるときは先に見送りを戻してください', null::uuid;
    return;
  end if;

  -- 同じ回への二重繰り上げを断る（2026-09-03。毎週の待ちは残るので起こり得る）
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
    -- 毎週の枠の待ちは**残す**（他の週のために待ち続ける・2026-09-03 ユーザー承認）
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
--   select tablename from pg_tables where tablename='room_waitlist_skips';
--   select has_function_privilege('anon','room_promote_waitlist_at(uuid,uuid,timestamptz,timestamptz)','execute') as anon_can;  -- false であること
--   select pg_get_functiondef(p.oid) like '%room_waitlist_skips%' as has_skip
--     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--    where n.nspname='public' and p.proname='room_promote_waitlist_at';
