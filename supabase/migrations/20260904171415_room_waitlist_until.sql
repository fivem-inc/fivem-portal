-- ============================================================
-- 場所予約：キャンセル待ちを「◯◯以降だけ」取り消せるようにする
--            （2026-09-04 ユーザー承認）
--
-- きっかけ：これまで「取り消す」は**今後ずっと**の一択だった。実際は
--   「10月から通えないので、10月以降だけ取り消したい」という運用がある。
--
-- 作り：room_waitlist.waiting_until（この日まで待つ・任意）。
--   ・null   … 期限なし（今までどおり）
--   ・日付   … その日までは待つ。**翌日以降は繰り上げの対象外**
--   「◯月◯日以降を取り消す」を選んだら waiting_until = 選んだ日の前日 を入れる
--   （🚨 選んだ日**そのものも対象外**＝ユーザー確定）。
--
-- 🚨 見送り（room_waitlist_skips）で代用できない。見送りは「待ち×回」なので、
--    **まだ作られていない先の回には付けられず**、月次更新で回が増えると復活する。
-- 🚨 判定は画面とサーバーの両方に入れる（㉕の失敗を繰り返さない）。
-- 🚨 引数は変えないので create or replace のみ。本番の実定義から起こしている。
--
-- ロールバック手順:
--   20260904165807 の room_promote_waitlist_at を流し直す;
--   alter table room_waitlist drop column if exists waiting_until;
-- ============================================================

alter table room_waitlist
  add column if not exists waiting_until date;

comment on column room_waitlist.waiting_until is
  'この日まで待つ（2026-09-04〜・任意）。翌日以降は繰り上げの対象外。null は期限なし';
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

  -- ★ 「◯◯以降を取り消す」で区切られた待ちは、その日以降には入れない（2026-09-04）
  --    🚨 選んだ日**そのものも対象外**（ユーザー確定）。日付で見るので、月次更新で
  --       先の回が増えても自動的に効く
  --    🚨 **v_starts が決まったあとに置くこと**。前に置くと空との比較になり、
  --       判定がまったく効かない（取り消し版の実測で発覚）
  if v_w.waiting_until is not null
     and (v_starts at time zone 'Asia/Tokyo')::date > v_w.waiting_until then
    return query select false,
      'この方は ' || to_char(v_w.waiting_until + 1, 'MM/DD') || ' 以降のキャンセル待ちを取り消しています',
      null::uuid;
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

-- 確認用:
--   select count(*) from information_schema.columns
--    where table_name='room_waitlist' and column_name='waiting_until';
