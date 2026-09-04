-- ============================================================
-- 場所予約：繰り上げが「通信を確認してください」で必ず失敗していたのを直す
--            （2026-09-04 実機で発覚・原因確定）
--
-- サーバーが投げていたエラー：
--   ERROR: 42702: column reference "booking_id" is ambiguous
--   DETAIL: It could refer to either a PL/pgSQL variable or a table column.
--
-- 🚨 この関数は returns table (ok, reason, **booking_id**) なので、
--    booking_id は**戻り値の変数でもある**。そこへ表の列として裸で
--    「booking_id = …」と書いたため、PostgreSQL が変数か列か決められず拒否した。
--
-- 該当は2か所（どちらも当方が入れたもの）：
--   ・見送りの判定（room_waitlist_skips・2026-09-04）
--   ・二重繰り上げの判定（room_waitlist_promotions・2026-09-03 の ㉖）
-- 🚨 ㉖ は**一度も動かしていなかった**ため今日まで発覚しなかった。
--    つまり 2026-09-03 以降、毎週の枠の繰り上げは1件も成功していない。
--
-- 直し方：両方の exists に**表の別名**を付けて、列であることを明示する。
-- 🚨 この定義は**本番の実定義（pg_get_functiondef）から起こし**、上の2か所だけを
--    直したもの。引数は変えていないので create or replace のみ（PGRST203 の心配なし）。
--
-- 🚨 次に似た関数を書く人へ：**戻り値の名前と同じ列を裸で書かない**。
--    returns table の名前（ok / reason / booking_id）は関数の中では変数になる。
--    where 句では必ず表の別名を付けること。
--
-- ロールバック手順:
--   20260904104149 の room_promote_waitlist_at を流し直す（ただし同じバグに戻る）
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
  if exists (select 1 from room_waitlist_promotions p
              where p.waitlist_id = v_w.id and p.booking_id = v_t.id) then
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
    insert into room_waitlist_promotions (waitlist_id, booking_id, created_by)
    values (v_w.id, v_t.id, auth.uid());
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

-- 確認用（実際に呼んで確かめる。begin/rollback で取り消すこと）:
--   select pg_get_functiondef(p.oid) like '%k.booking_id%' as fixed
--     from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--    where n.nspname='public' and p.proname='room_promote_waitlist_at';
