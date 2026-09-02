-- ============================================================
-- 場所予約：キャンセル待ちを「枠」単位にする（2026-09-02 ユーザー承認・案A）
--
-- 何を変えるか:
--   これまでキャンセル待ちは「特定の1回の予約」にぶら下がっていた。
--   実際の運用は「毎週火曜16:00の◯◯先生の枠が空いたら入りたい」なので、
--   **毎週の枠（room_recurrences）にもぶら下げられる**ようにする。
--   ・毎週の枠を待つ … recurrence_id を入れる（booking_id は null）
--   ・この回だけ待つ … booking_id を入れる（今までどおり）
--   どちらか片方だけが入る（check 制約）。
--
-- 🚨 担当者が違えば別の枠。同じ曜日・時間でも繰り返し（recurrence）が
--    別なら待ち行列も別になる。画面の一覧も recurrence ごとにまとめる。
--
-- 🚨 既存の room_promote_waitlist(uuid) には**手を入れない**
--    （RPCを create or replace で上書きして事故になった前例があるため）。
--    代わりに「どの日に入れるか」を指定できる新しい関数を**別名で**作り、
--    画面は新しい関数だけを呼ぶ。古い関数は残るが呼ばれなくなる。
--
-- 🚨 自動では繰り上げない・通知は作らない（2026-08-31 の方針のまま）。
--
-- ロールバック手順:
--   drop function if exists room_promote_waitlist_at(uuid, uuid);
--   update room_waitlist w set booking_id = null where booking_id is not null and recurrence_id is not null; -- 移行前の形には正確には戻らない
--   alter table room_waitlist drop constraint if exists room_waitlist_target;
--   alter table room_waitlist drop column if exists recurrence_id;
--   alter table room_waitlist alter column booking_id set not null;
-- ============================================================

-- ① 枠（繰り返し）を指せるようにする --------------------------
alter table room_waitlist
  add column if not exists recurrence_id uuid references room_recurrences(id) on delete cascade;

alter table room_waitlist alter column booking_id drop not null;

-- ② 既存の「待ち」を移し替える --------------------------------
--    繰り返し予約の1回に付いていた待ちは「毎週の枠を待っている」とみなして
--    recurrence 側へ移す（運用の実態がそうであるため・2026-09-02 ユーザー承認）。
--    単発の予約に付いていた待ちと、処理済み（promoted/cancelled）の行は触らない。
update room_waitlist w
   set recurrence_id = b.recurrence_id,
       booking_id    = null,
       updated_at    = now()
  from room_bookings b
 where w.booking_id = b.id
   and w.status = 'waiting'
   and b.recurrence_id is not null;

-- ③ どちらか片方だけ、を約束にする ----------------------------
alter table room_waitlist drop constraint if exists room_waitlist_target;
alter table room_waitlist
  add constraint room_waitlist_target
  check ((booking_id is null) <> (recurrence_id is null));

create index if not exists idx_room_waitlist_recurrence
  on room_waitlist (recurrence_id) where status = 'waiting';

-- ④ 繰り上げ（入れる日を指定できる版）--------------------------
--    p_target_booking_id ＝ その枠の「どの回に入れるか」（予約表の1行）。
--    ・毎週の枠の待ち … 同じ recurrence の回であること
--    ・この回だけの待ち … 待ちが付いている予約そのものであること
--    を確かめてから、その回と同じ場所・時間で予約を作る。
--    🚨 空きの判定は作り直さず room_create_booking に任せる（今までどおり）。
--       もとの回がまだ生きていて空きが無ければ、理由つきで弾かれる。
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

  -- 待ちと入れる先が食い違っていないか
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
    null,                                   -- 繰り返しには結び付けない（この回だけ）
    coalesce(v_w.staff_id, v_t.staff_id),
    'booking',
    1
  );

  if not coalesce(v_res.ok, false) then
    -- 🚨 入らない理由をそのまま返す。多くは「その回がまだ生きている」
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

-- 🚨 新しい関数には anon の実行権限が自動で付く。必ず外す
--    （revoke from public だけでは外れない・CLAUDE.md の決まり）
revoke execute on function room_promote_waitlist_at(uuid, uuid) from public;
revoke execute on function room_promote_waitlist_at(uuid, uuid) from anon;
grant  execute on function room_promote_waitlist_at(uuid, uuid) to authenticated;
grant  execute on function room_promote_waitlist_at(uuid, uuid) to service_role;

-- 確認用:
--   select count(*) filter (where recurrence_id is not null) as slot_waits,
--          count(*) filter (where booking_id is not null)    as single_waits
--     from room_waitlist where status = 'waiting';
--   select p.proname, r.rolname
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--     cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
--     join pg_roles r on r.oid = a.grantee
--    where n.nspname = 'public' and p.proname = 'room_promote_waitlist_at';
