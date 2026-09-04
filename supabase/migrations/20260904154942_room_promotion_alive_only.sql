-- ============================================================
-- 場所予約：繰り上げた予約を削除したら「入っています」が戻るようにする
--            （2026-09-04 実機指摘・ユーザー承認）
--
-- 症状：固定枠でお休み→繰り上げ→**繰り上げた予約を削除**→お休みを取り消した後も、
--   日付選びに「入っています」が残り、もう一度繰り上げられなかった。
--
-- 原因：room_waitlist_promotions は「どの待ちが、どの回に入れたか」しか持っておらず、
--   **その結果できた予約**を記録していなかった。だから消えたかどうかを知る手立てが無く、
--   記録があるだけで断り続けていた。
--
-- 直し方：created_booking_id（繰り上げで作った予約）を持たせ、判定を
--   「記録がある **かつ その予約がまだ生きている**」に変える。
--   削除すれば自動で戻り、もう一度繰り上げられる。記録自体は履歴として残す。
-- 🚨 画面（WaitlistSettings の promoted）も同じ判定に直すこと。片方だけだと
--    「押せるのに弾かれる」「弾かれないのに押せない」になる。
-- 🚨 既存の記録2件は created_booking_id が空。対応する予約が分からないので**断らない**
--    （今日より前は繰り上げ自体が成功していないため、実害のある古い記録は無い）。
--
-- ロールバック手順:
--   20260904144543 の room_promote_waitlist_at を流し直す;
--   alter table room_waitlist_promotions drop column if exists created_booking_id;
-- ============================================================

alter table room_waitlist_promotions
  add column if not exists created_booking_id uuid references room_bookings(id) on delete set null;

comment on column room_waitlist_promotions.created_booking_id is
  '繰り上げで作った予約（2026-09-04〜）。🚨 これが生きているときだけ二重繰り上げを断る';
CREATE OR REPLACE FUNCTION public.room_promote_waitlist_at(p_waitlist_id uuid, p_target_booking_id uuid, p_starts_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_ends_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(ok boolean, reason text, booking_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  if exists (select 1 from room_waitlist_skips k
              where k.waitlist_id = v_w.id and k.booking_id = v_t.id) then
    return query select false, 'この方は、この日を見送りにしています。入れるときは先に見送りを戻してください', null::uuid;
    return;
  end if;

  -- 同じ回への二重繰り上げを断る（2026-09-03。毎週の待ちは残るので起こり得る）
  -- 🚨 記録があるだけでは断らない。**繰り上げでできた予約がまだ生きているとき**だけ断る
  --    （2026-09-04 実機指摘。繰り上げた予約を削除しても「入っています」のままだった）。
  --    created_booking_id が空の古い記録は、対応する予約が分からないので断らない
  if exists (select 1 from room_waitlist_promotions p
               join room_bookings cb on cb.id = p.created_booking_id
              where p.waitlist_id = v_w.id and p.booking_id = v_t.id
                and cb.deleted_at is null and cb.status = 'active') then
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
  -- 🚨 ここも booking_id が曖昧になる（on conflict の列名には別名を付けられない）。
  --    重なりは上の exists で弾いているので、万一の同時押しだけ例外で握りつぶす
  begin
    insert into room_waitlist_promotions (waitlist_id, booking_id, created_booking_id, created_by)
    values (v_w.id, v_t.id, v_res.booking_id, auth.uid());
  exception when unique_violation then
    null;
  end;

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
$function$
;

revoke execute on function room_promote_waitlist_at(uuid, uuid, timestamptz, timestamptz) from public;
revoke execute on function room_promote_waitlist_at(uuid, uuid, timestamptz, timestamptz) from anon;
grant  execute on function room_promote_waitlist_at(uuid, uuid, timestamptz, timestamptz) to authenticated;
grant  execute on function room_promote_waitlist_at(uuid, uuid, timestamptz, timestamptz) to service_role;

-- 確認用:
--   select count(*) from information_schema.columns
--    where table_name='room_waitlist_promotions' and column_name='created_booking_id';
