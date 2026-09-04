-- ============================================================
-- 場所予約：繰り上げ直したときに記録を上書きする＋古い記録の穴埋め
--            （2026-09-04 実機で発覚・ユーザー承認）
--
-- 症状：繰り上げ→削除→繰り上げ直し、をすると、日付選びが「この日に入れる」の
--   ままになる（本当は予約が入っている）。
--
-- 原因：room_waitlist_promotions は (waitlist_id, booking_id) で一意。
--   繰り上げ直しの insert は重複で弾かれ、**例外を握りつぶしていた**ので、
--   記録が**削除済みの古い予約**（または空）を指したままになっていた。
--   🚨 「削除したら繰り上げ直せる」を可能にした 20260904154942 の**続きの抜け**。
--      作る側だけ直して、**作り直す側**を見ていなかった。
--
-- 直し方：重複したときは update して created_booking_id を最新に上書きする。
--   🚨 on conflict の列名には別名を付けられない（booking_id が戻り値の変数と衝突する）ので、
--      例外で受けてから別名付きの update を行う。
--
-- あわせて、列を足す前に作られた記録2件を穴埋めする（実データで1件ずつ特定済み）。
--   🚨 推測では埋めない。同じ日・同じ担当・同じお客様で**いま生きている**予約に限る。
--
-- ロールバック手順:
--   20260904154942 の room_promote_waitlist_at を流し直す;
--   update room_waitlist_promotions set created_booking_id = null where id in (…上の2件…);
-- ============================================================
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
  -- 🚨 記録は「待ち×回」で一意なので、**繰り上げ直したときは上書きする**
  --    （2026-09-04 実機で発覚）。握りつぶすと、記録が**削除済みの古い予約**を
  --    指したままになり、画面が「繰り上げ済み」と分からなくなる。
  --    on conflict の列名には別名を付けられないので、例外で受けて update する
  begin
    insert into room_waitlist_promotions (waitlist_id, booking_id, created_booking_id, created_by)
    values (v_w.id, v_t.id, v_res.booking_id, auth.uid());
  exception when unique_violation then
    update room_waitlist_promotions p
       set created_booking_id = v_res.booking_id,
           created_at = now(),
           created_by = auth.uid()
     where p.waitlist_id = v_w.id and p.booking_id = v_t.id;
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

-- ------------------------------------------------------------
-- 古い記録の穴埋め（2件・実データで特定済み）
-- 🚨 id を明示し、いま空のものだけを対象にする（二重に走っても害が無いように）
-- ------------------------------------------------------------
update room_waitlist_promotions set created_booking_id = 'b6dbebc3-b596-4a13-9964-3a4a66544621'
 where id = 'a11bd005-18a8-4332-90ff-7b60ab59aa24' and created_booking_id is null;

update room_waitlist_promotions set created_booking_id = '16cc3ece-4ea5-4ecf-b861-6a6f3b53030b'
 where id = 'e578e4fa-c833-4cf0-b5af-f9645ddc1350' and created_booking_id is null;

-- 確認用:
--   select id, created_booking_id from room_waitlist_promotions;
