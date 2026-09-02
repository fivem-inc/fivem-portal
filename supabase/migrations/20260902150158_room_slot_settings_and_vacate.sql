-- ============================================================
-- 場所予約：枠ごとの設定と「空き枠にする」（2026-09-02 ユーザー承認）
--
-- ① 毎週の枠（room_recurrences）に設定を2つ持たせる
--    ・auto_open_slot  … 空きが出たとき「空き枠にする」ボタンを出すか（既定 ON）
--    ・waitlist_closed … キャンセル待ちの受付を締め切るか（既定 OFF＝受け付ける）
--    どちらも予約の詳細画面（繰り返しの予約）から切り替える。
--    🚨 room_renew_recurrence（年度更新）はこの2列をコピーしない（detail 列と同じ扱い。
--       中心のRPCは触らない方針のため）。引き継いだ枠は既定値に戻る。
--
-- ② 「空き枠にする」＝ その回を休講にして、同じ時間に募集中の枠（kind='open'）を作る。
--    休みの連絡があった記録（予約と出欠）はそのまま残る。
--    🚨 全自動にはしない（ユーザー確定・1タップ方式）。出欠は押し間違いを
--       取り消せる作りなので、自動で枠を公開すると取り消したときに
--       空き枠だけが残って二重予約の種になる。公開の最終判断は人が押す。
--
-- ロールバック手順:
--   drop function if exists room_vacate_to_open(uuid);
--   alter table room_recurrences drop column if exists auto_open_slot;
--   alter table room_recurrences drop column if exists waitlist_closed;
-- ============================================================

alter table room_recurrences
  add column if not exists auto_open_slot boolean not null default true;
alter table room_recurrences
  add column if not exists waitlist_closed boolean not null default false;

-- ------------------------------------------------------------
-- その回を「空き枠」にする。
--   ・すでに休講の回 … そのまま募集中の枠を作る
--   ・生きている回 … 空き扱いの出欠（waitlist_open_statuses）が全員に
--     付いているときだけ、休講にしてから募集中の枠を作る
--   🚨 それ以外（出席予定の人がいる回など）は理由を出して断る。
--   🚨 取り消し済み（deleted_at あり）の回は対象外。空きはすでに
--      予約表に見えているので、普通に枠を置けばよい。
-- ------------------------------------------------------------
create or replace function room_vacate_to_open(p_booking_id uuid)
returns table (ok boolean, reason text, booking_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
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

  select * into v_t from room_bookings where id = p_booking_id;
  if not found or v_t.deleted_at is not null then
    return query select false, 'この回が見つかりませんでした', null::uuid;
    return;
  end if;
  if v_t.kind <> 'booking' then
    return query select false, 'この回はすでに募集中の枠です', null::uuid;
    return;
  end if;

  if v_t.status = 'active' then
    select coalesce(array_agg(btrim(x)), '{}') into v_open
      from unnest(string_to_array(
        coalesce((select value from room_settings where key = 'waitlist_open_statuses'),
                 '休み,キャンセル料'), ',')) x
     where btrim(x) <> '';

    select greatest(
      (select count(*) from unnest(string_to_array(coalesce(v_t.customer_label, ''), ',')) s where btrim(s) <> ''),
      (select count(*) from unnest(string_to_array(coalesce(v_t.member_no, ''), ',')) s where btrim(s) <> ''),
      1) into v_people;

    select count(*),
           count(*) filter (where btrim(a.status) = any (v_open))
      into v_att_total, v_att_open
      from room_booking_attendance a
     where a.booking_id = v_t.id;

    if not (v_att_total >= v_people and v_att_open = v_att_total and v_att_total > 0) then
      return query select false, '空き扱いの出欠（休みなど）が全員に付いていないため、空き枠にできません', null::uuid;
      return;
    end if;

    update room_bookings
       set status = 'cancelled', updated_at = now(), updated_by = auth.uid()
     where id = v_t.id;
  end if;

  -- 同じ場所・時間に募集中の枠を作る。空きの判定は room_create_booking に任せる
  select * into v_res from room_create_booking(
    v_t.floor_id,
    v_t.starts_at,
    v_t.ends_at,
    v_t.purpose,
    v_t.booker_name,
    null,
    null,
    null,
    false,
    null,                                   -- 🚨 繰り返しには結び付けない（「今後すべて」の操作に巻き込まれないように）
    v_t.staff_id,
    'open',
    1
  );

  if not coalesce(v_res.ok, false) then
    return query select false, coalesce(v_res.reason, '空き枠を作れませんでした'), null::uuid;
    return;
  end if;

  return query select true, null::text, v_res.booking_id;
end;
$$;

-- 🚨 新しい関数には anon の実行権限が自動で付く。必ず外す
revoke execute on function room_vacate_to_open(uuid) from public;
revoke execute on function room_vacate_to_open(uuid) from anon;
grant  execute on function room_vacate_to_open(uuid) to authenticated;
grant  execute on function room_vacate_to_open(uuid) to service_role;

-- 確認用:
--   select column_name from information_schema.columns
--    where table_name = 'room_recurrences'
--      and column_name in ('auto_open_slot', 'waitlist_closed');
