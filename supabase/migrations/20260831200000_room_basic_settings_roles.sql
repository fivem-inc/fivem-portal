-- ============================================================
-- 場所予約：「基本設定」を使える役職を管理者が変えられるようにする
--            （2026-08-31 ユーザー確定・案A）
--
-- なぜ必要か:
--   正社員の中にも役職がある（一般／リーダー／フロア責任者／マネージャー／社長）。
--   「パートでなければ全員」だと粗すぎるので、管理者が役職ごとに決められるようにする。
--
-- どこで決めるか:
--   room_settings の 'basic_settings_roles'（カンマ区切りの役職名）。
--   画面は ⚙️ 設定 →「基本設定の権限」タブ。
--   🚨 「リーダー以上」のような序列では持たない。フロア責任者をどちら側に
--      含めるかで過去に判断が割れているため（CLAUDE.md「役職序列」）。
--
-- このファイルがすること:
--   すでに適用済みの 20260829100000〜300000 で作った判定を、
--   room_is_staff()（＝パートでない）から
--   room_can_use_basic_settings()（＝役職の設定も見る）に差し替える。
--
--   🚨 実行の前に 20260829400000_room_customers.sql を流しておくこと。
--      room_settings と room_can_use_basic_settings() はそちらで作られる。
--
-- 変えないもの:
--   room_can_see_contacts() の 'staff' は「雇用形態が社員か」の意味なので
--   room_is_staff() のままにする。役職の設定とは別の話。
--   room_waitlist は予約と同じ扱い（全員が読み書き）。基本設定の権限とは無関係。
--
-- ロールバック手順:
--   room_is_staff() を使う形に戻す（20260829200000 / 300000 の定義に戻す）
-- ============================================================

-- 1) 用途ごとの長さ（20260829200000 で作ったもの）
drop policy if exists room_purpose_durations_write on room_purpose_durations;
create policy room_purpose_durations_write on room_purpose_durations
  for all to authenticated
  using (room_can_use_basic_settings())
  with check (room_can_use_basic_settings());

-- 2) スタッフと担当区分（20260829300000 で作ったもの）
drop policy if exists room_staff_write on room_staff;
create policy room_staff_write on room_staff
  for all to authenticated
  using (room_can_use_basic_settings())
  with check (room_can_use_basic_settings());

drop policy if exists room_staff_categories_write on room_staff_categories;
create policy room_staff_categories_write on room_staff_categories
  for all to authenticated
  using (room_can_use_basic_settings())
  with check (room_can_use_basic_settings());

-- ------------------------------------------------------------
-- 3) 年度更新の関数も同じ判定にする
--    （20260829100000 の定義と中身は同じ。判定の1行だけ差し替え）
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

  return query select true, null::text, v_new, v_made, v_skipped;
end;
$$;
