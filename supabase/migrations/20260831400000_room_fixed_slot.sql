-- ============================================================
-- 場所予約：枠が「固定」かどうかを持たせる（2026-08-31 ユーザー確定・案A）
--
-- 何のための印か（ユーザー説明）:
--   ・来週も基本的に入っている枠かどうかの判断材料にする
--   ・パーソナルは、固定かどうかで**金額が変わる**
--
-- 🚨 **人ではなく「曜日・時間の枠」の性質**（ユーザー明言）。
--    「この人が固定客」ではなく「この曜日のこの時間は固定の枠」という意味。
--    なので繰り返しで作った予約は、全部の回に同じ値が入る。
--
-- 既定:
--   false（＝固定ではない）。未記載は固定でない、とユーザー確定。
--   既にある予約もすべて false になる。
--
-- 設計の判断:
--   🚨 room_create_booking（二重予約の判定をしている中心の関数）には手を入れない。
--      引数を増やすより、作ったあとに is_fixed を書き込むほうが安全。
--      印であって、入れられるかどうかの判定には関係しないため。
--
-- ロールバック手順:
--   alter table room_bookings   drop column is_fixed;
--   alter table room_recurrences drop column is_fixed;
--   （room_renew_recurrence / room_promote_waitlist は
--     20260831200000 / 20260831100000 の定義に戻す）
-- ============================================================

alter table room_bookings
  add column if not exists is_fixed boolean not null default false;

alter table room_recurrences
  add column if not exists is_fixed boolean not null default false;

-- 固定の枠だけを拾う索引（一覧や集計で使う）
create index if not exists idx_room_bookings_fixed
  on room_bookings (starts_at)
  where is_fixed and deleted_at is null;

-- ------------------------------------------------------------
-- キャンセル待ちの繰り上げでも、もとの枠の「固定」を引き継ぐ
--   （枠の性質なので、入る人が変わっても枠は固定のまま）
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
    v_b.floor_id, v_b.starts_at, v_b.ends_at, v_b.purpose, v_b.booker_name,
    v_w.member_no, v_w.customer_label, v_w.note, v_b.exclusive,
    null, coalesce(v_w.staff_id, v_b.staff_id), 'booking', 1
  );

  if not coalesce(v_res.ok, false) then
    return query select false, coalesce(v_res.reason, '予約を作れませんでした'), null::uuid;
    return;
  end if;

  -- 🚨 枠の性質なので引き継ぐ。作ったあとに書き込む（作る関数は触らない）
  update room_bookings set is_fixed = v_b.is_fixed where id = v_res.booking_id;

  update room_waitlist
     set status = 'promoted',
         promoted_booking_id = v_res.booking_id,
         updated_at = now()
   where id = p_waitlist_id;

  return query select true, null::text, v_res.booking_id;
end;
$$;

-- ------------------------------------------------------------
-- 年度更新でも「固定」を引き継ぐ
--   （20260831200000 の定義と同じ。is_fixed の引き継ぎだけ足した）
-- ------------------------------------------------------------
create or replace function room_renew_recurrence(
  p_recurrence_id  uuid,
  p_fiscal_year    int,
  p_floor_id       uuid default null,
  p_weekday        int  default null,
  p_start_time     time default null,
  p_end_time       time default null,
  p_staff_id       uuid default null,
  p_member_no      text default null,
  p_customer_label text default null
)
returns table (ok boolean, reason text, new_recurrence_id uuid, made int, skipped date[])
language plpgsql
security definer
set search_path = public
as $$
declare
  v_src     room_recurrences;
  v_floor   uuid;
  v_wd      int;
  v_st      time;
  v_et      time;
  v_member  text;
  v_label   text;
  v_today   date := (now() at time zone 'Asia/Tokyo')::date;
  v_from    date;
  v_to      date;
  v_d       date;
  v_new     uuid;
  v_made    int := 0;
  v_skipped date[] := '{}';
  v_res     record;
begin
  if auth.uid() is null then
    return query select false, 'ログインし直してください', null::uuid, 0, '{}'::date[];
    return;
  end if;

  -- 社員まで。パートは不可
  if not room_can_use_basic_settings() then
    return query select false, '年度更新を行える役職ではありません', null::uuid, 0, '{}'::date[];
    return;
  end if;

  select * into v_src from room_recurrences where id = p_recurrence_id;
  if not found then
    return query select false, 'もとの繰り返しが見つかりませんでした', null::uuid, 0, '{}'::date[];
    return;
  end if;

  -- 🚨 二度押しで同じ予約が二重に作られるのを防ぐ
  if exists (select 1 from room_recurrences
              where renewed_from = p_recurrence_id and fiscal_year = p_fiscal_year) then
    return query select false, 'この繰り返しは、すでにこの年度へ引き継ぎ済みです',
                        null::uuid, 0, '{}'::date[];
    return;
  end if;

  v_floor  := coalesce(p_floor_id,   v_src.floor_id);
  v_wd     := coalesce(p_weekday,    v_src.weekday);
  v_st     := coalesce(p_start_time, v_src.start_time);
  v_et     := coalesce(p_end_time,   v_src.end_time);
  v_member := nullif(btrim(coalesce(p_member_no, '')), '');
  v_label  := nullif(btrim(coalesce(p_customer_label, '')), '');

  if v_et <= v_st then
    return query select false, '終了は開始より後にしてください', null::uuid, 0, '{}'::date[];
    return;
  end if;
  if v_wd < 0 or v_wd > 6 then
    return query select false, '曜日の指定が正しくありません', null::uuid, 0, '{}'::date[];
    return;
  end if;

  -- その年度の範囲。過ぎた日には作らない
  v_from := greatest(room_fiscal_start(p_fiscal_year), v_today);
  v_to   := room_fiscal_end(p_fiscal_year);
  if v_from > v_to then
    return query select false, 'その年度はすでに終わっています', null::uuid, 0, '{}'::date[];
    return;
  end if;

  -- 最初の該当曜日まで進める（0=日曜。JS の getDay と同じ）
  while extract(dow from v_from)::int <> v_wd loop
    v_from := v_from + 1;
  end loop;
  if v_from > v_to then
    return query select false, 'その年度に対象の曜日がありません', null::uuid, 0, '{}'::date[];
    return;
  end if;

  insert into room_recurrences (
    floor_id, weekday, start_time, end_time, purpose, booker_name,
    member_no, customer_label, memo, exclusive, staff_id, kind, seats,
    start_date, end_date, generated_to, fiscal_year, renewed_from, created_by
  ) values (
    v_floor, v_wd, v_st, v_et, v_src.purpose, v_src.booker_name,
    v_member, v_label, v_src.memo, v_src.exclusive, p_staff_id, v_src.kind, v_src.seats,
    v_from, v_to, v_to, p_fiscal_year, p_recurrence_id, auth.uid()
  ) returning id into v_new;

  v_d := v_from;
  while v_d <= v_to loop
    -- 🚨 重なりの判定は作り直さない。既存の関数にそのまま任せる
    select * into v_res from room_create_booking(
      v_floor,
      (v_d + v_st) at time zone 'Asia/Tokyo',
      (v_d + v_et) at time zone 'Asia/Tokyo',
      v_src.purpose,
      v_src.booker_name,
      v_member,
      v_label,
      v_src.memo,
      v_src.exclusive,
      v_new,
      p_staff_id,
      v_src.kind,
      v_src.seats
    );
    if coalesce(v_res.ok, false) then
      v_made := v_made + 1;
    else
      v_skipped := v_skipped || v_d;
    end if;
    v_d := v_d + 7;
  end loop;

  -- 1件も入らなかったら、親だけが残って迷子になるので消しておく
  if v_made = 0 then
    delete from room_recurrences where id = v_new;
    return query select false, 'すべての回が先約と重なったため、1件も作成できませんでした',
                        null::uuid, 0, v_skipped;
    return;
  end if;


  -- 🚨 枠の「固定」を引き継ぐ。まとめて1回で書き込む
  update room_recurrences set is_fixed = v_src.is_fixed where id = v_new;
  update room_bookings     set is_fixed = v_src.is_fixed where recurrence_id = v_new;

  return query select true, null::text, v_new, v_made, v_skipped;
end;
$$;
