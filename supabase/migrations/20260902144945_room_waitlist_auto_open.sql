-- ============================================================
-- 場所予約：出欠とキャンセル待ちの連動（2026-09-02 ユーザー承認・案①）
--
-- 何をするものか:
--   「休み」「キャンセル料」など**空き扱いの出欠**が付いた回は、
--   予約を消したり手で休講にしたりしなくても、そのまま繰り上げられるようにする。
--   繰り上げの瞬間に、その回をサーバーが**自動で休講**にしてから新しい予約を作る。
--   → 元の予約と出欠の記録（休みの連絡があったこと）はそのまま残る。
--
-- どの出欠を空き扱いにするか:
--   room_settings の 'waitlist_open_statuses'（カンマ区切りの出欠名）。
--   初期値は「休み,キャンセル料」（ユーザー指定）。⚙️設定 → キャンセル待ち で変えられる。
--
-- 🚨 空き扱いの出欠が付いていない回（未入力・出席など）は自動化しない。
--    来る予定のお客様がいる回に繰り上げで割り込めないようにする安全装置。
--    その場合は今までどおり「先に休講または取り消してください」で止まる。
-- 🚨 2名の予約は「参加者全員に空き扱いの出欠が付いているとき」だけ空きになる。
-- 🚨 通知は作らない（新しい通知は46人に飛ぶ・従来方針のまま）。
--
-- room_promote_waitlist_at は 2026-09-02 の 20260902105641 で当方が作成し
-- 同日に適用した関数（他所からの変更なし）。それを拡張して置き換える。
--
-- ロールバック手順:
--   20260902105641_room_waitlist_slot.sql の room_promote_waitlist_at を流し直す;
--   delete from room_settings where key = 'waitlist_open_statuses';
-- ============================================================

-- ① 空き扱いにする出欠（管理者が ⚙️設定 から変えられる）
insert into room_settings (key, value) values ('waitlist_open_statuses', '休み,キャンセル料')
on conflict (key) do nothing;

-- ② 繰り上げ関数を拡張：空き扱いの回は自動で休講にしてから予約を作る
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
  v_w          room_waitlist;
  v_t          room_bookings;
  v_res        record;
  v_open       text[];
  v_people     int;
  v_att_total  int;
  v_att_open   int;
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

  -- ★ ここが今回の追加：空き扱いの出欠が付いた回なら、自動で休講にして枠を空ける
  if v_t.status = 'active' and v_t.deleted_at is null and v_t.kind = 'booking' then
    select coalesce(array_agg(btrim(x)), '{}') into v_open
      from unnest(string_to_array(
        coalesce((select value from room_settings where key = 'waitlist_open_statuses'),
                 '休み,キャンセル料'), ',')) x
     where btrim(x) <> '';

    -- 参加者の人数（会員番号とお名前はカンマでつながっている。多いほうに合わせる）
    select greatest(
      (select count(*) from unnest(string_to_array(coalesce(v_t.customer_label, ''), ',')) s where btrim(s) <> ''),
      (select count(*) from unnest(string_to_array(coalesce(v_t.member_no, ''), ',')) s where btrim(s) <> ''),
      1) into v_people;

    select count(*),
           count(*) filter (where btrim(a.status) = any (v_open))
      into v_att_total, v_att_open
      from room_booking_attendance a
     where a.booking_id = v_t.id;

    -- 全員ぶんの出欠があり、そのすべてが空き扱い → 休講にして空ける
    if v_att_total >= v_people and v_att_open = v_att_total and v_att_total > 0 then
      update room_bookings
         set status = 'cancelled', updated_at = now(), updated_by = auth.uid()
       where id = v_t.id;
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

-- 🚨 置き換えでも権限を再確認して外す（新規作成時と同じ扱いにしておく）
revoke execute on function room_promote_waitlist_at(uuid, uuid) from public;
revoke execute on function room_promote_waitlist_at(uuid, uuid) from anon;
grant  execute on function room_promote_waitlist_at(uuid, uuid) to authenticated;
grant  execute on function room_promote_waitlist_at(uuid, uuid) to service_role;

-- 確認用:
--   select value from room_settings where key = 'waitlist_open_statuses';
