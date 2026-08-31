-- ============================================================
-- 部屋（フロア）予約  ※2026-08-28 新規
--
-- 何をするものか:
--   5校のフロアを「いつ・誰が・何に使うか」で押さえるための予約表。
--   スタッフ全員が予約・閲覧できる（承認フローなし・権限分けなし）。
--
-- 既存機能との関係:
--   すべて room_ 接頭辞の新規テーブルのみ。既存テーブルは一切変更しない。
--   参照するのは auth.users だけ（業務テーブルへのFKは張らない）。
--   → 予約側の変更が交通費・休暇・シフト等を壊す経路を構造的に作らない。
--
-- 予約単位（2026-08-28 ユーザー確定）:
--   「部屋」ではなく「フロア」。四条本校のみ 3階/5階 の2つ、他4校は1つずつ＝計6。
--   各フロア 同時3件まで（先生3組が同時に使える）。
--   占有(exclusive)を立てた予約がある時間は、上限に関係なく他の予約を入れない。
--
-- 営業時間:
--   基準は 9:30〜20:00。ただし前後1時間のイレギュラーがあるため
--   予約自体はブロックしない（画面は 8:30〜21:00 を描き、基準外は薄く見せる）。
--   room_campuses.open_time/close_time は「基準時間」であって制約ではない。
--
-- 個人情報の方針:
--   顧客はフルネームを持たない。会員番号(member_no)＋敬称付き表示名(customer_label)のみ。
--   詳細はスコラプラス側で見る（画面のボタンで会員番号リンクを開く）。
--   → 漏えい時の被害と説明責任を最小化する。連絡先・生年月日等は絶対に足さないこと。
--
-- ロールバック手順（逆順・依存関係の順）:
--   drop function if exists room_create_booking(...);
--   drop function if exists room_check_conflict(...);
--   drop table if exists room_bookings;
--   drop table if exists room_recurrences;
--   drop table if exists room_floors;
--   drop table if exists room_campuses;
-- ============================================================

-- ------------------------------------------------------------
-- 1) 校
--    校名は既存の master_options(category='workplace') と同じ表記を入れる。
--    FKは張らない（master_options は自由に増減される運用のため、
--    予約側が道連れで壊れないよう文字列で持つ）。
-- ------------------------------------------------------------
create table if not exists room_campuses (
  id          uuid primary key default gen_random_uuid(),
  name        text not null unique,                 -- 例 '四条本校'
  open_time   time not null default '09:30',        -- 基準の営業開始（制約ではない）
  close_time  time not null default '20:00',        -- 基準の営業終了（制約ではない）
  sort_order  int  not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 2) フロア（＝予約の単位。タイムラインの横に並ぶもの）
-- ------------------------------------------------------------
create table if not exists room_floors (
  id          uuid primary key default gen_random_uuid(),
  campus_id   uuid not null references room_campuses(id) on delete cascade,
  name        text not null,                        -- 例 '3階' / '5階' / '全体'
  capacity    int  not null default 3 check (capacity >= 1),  -- 同時に入れられる予約の件数
  sort_order  int  not null default 0,
  active      boolean not null default true,        -- 改装中などは false で一覧から隠す
  created_at  timestamptz not null default now(),
  unique (campus_id, name)
);
create index if not exists idx_room_floors_campus on room_floors (campus_id, sort_order);

-- ------------------------------------------------------------
-- 3) 繰り返しのルール（毎週◯曜だけ。隔週・第◯曜は作らない）
--    子の予約(room_bookings)を一定期間ぶん実体として作る「展開保存」方式。
--    ルールだけ持つ方式にしないのは、「今週だけ休講」「この回だけ時間変更」が
--    普通の1行の編集で済み、重なり判定もタイムライン表示も単純になるため。
-- ------------------------------------------------------------
create table if not exists room_recurrences (
  id             uuid primary key default gen_random_uuid(),
  floor_id       uuid not null references room_floors(id) on delete cascade,
  weekday        int  not null check (weekday between 0 and 6),  -- 0=日曜（JS/Postgres dow と同じ）
  start_time     time not null,
  end_time       time not null,
  purpose        text not null,
  booker_name    text not null,
  member_no      text,
  customer_label text,
  memo           text,
  exclusive      boolean not null default false,
  start_date     date not null,
  end_date       date,                              -- null = 無期限
  generated_to   date,                              -- ここまで子予約を作った（自動延長の起点）
  active         boolean not null default true,
  created_by     uuid not null references auth.users(id),
  created_at     timestamptz not null default now(),
  check (end_time > start_time)
);

-- ------------------------------------------------------------
-- 4) 予約1件
--    繰り返しも1回ずつ実体を持つ（recurrence_id で親をたどる）。
--    削除は物理削除せず deleted_at を入れる（「誰が消したか」を残すため）。
-- ------------------------------------------------------------
create table if not exists room_bookings (
  id             uuid primary key default gen_random_uuid(),
  floor_id       uuid not null references room_floors(id) on delete cascade,
  starts_at      timestamptz not null,
  ends_at        timestamptz not null,
  purpose        text not null,                     -- プライベート/パーソナル/レッスン/レンタル/その他
  booker_name    text not null,                     -- 予約した人（ログイン名を初期値・変更可）
  member_no      text,                              -- スコラプラスの会員番号（リンク生成に使う）
  customer_label text,                              -- 例 '田中様'。フルネーム・連絡先は入れない
  memo           text,
  exclusive      boolean not null default false,    -- true = その時間は他の予約を一切入れさせない
  status         text not null default 'active'
                 check (status in ('active','cancelled')),  -- cancelled = 休講（枠は残して見せる）
  recurrence_id  uuid references room_recurrences(id) on delete set null,
  created_by     uuid not null references auth.users(id),
  updated_by     uuid references auth.users(id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,
  deleted_by     uuid references auth.users(id),
  check (ends_at > starts_at)
);

-- 一覧は「このフロアの、この日の、生きている予約」を引く形しかないので複合で張る
create index if not exists idx_room_bookings_floor_time
  on room_bookings (floor_id, starts_at) where deleted_at is null;
create index if not exists idx_room_bookings_recurrence
  on room_bookings (recurrence_id) where deleted_at is null;

-- ------------------------------------------------------------
-- 5) RLS
--    社内ツールなので「ログイン済みなら全員が読み書きできる」。
--    権限を細分化しない代わりに、誰が何をしたかを履歴（created_by/updated_by/
--    deleted_by）で必ず残す方針。
-- ------------------------------------------------------------
alter table room_campuses   enable row level security;
alter table room_floors     enable row level security;
alter table room_recurrences enable row level security;
alter table room_bookings   enable row level security;

drop policy if exists room_campuses_all on room_campuses;
create policy room_campuses_all on room_campuses
  for all to authenticated using (true) with check (true);

drop policy if exists room_floors_all on room_floors;
create policy room_floors_all on room_floors
  for all to authenticated using (true) with check (true);

drop policy if exists room_recurrences_all on room_recurrences;
create policy room_recurrences_all on room_recurrences
  for all to authenticated using (true) with check (true);

-- 予約の追加だけは直接 insert させない（重なり判定を必ず通すため RPC 経由に限定）。
-- select / update / delete は許可（更新時の重なりは update 用 RPC で見る）。
drop policy if exists room_bookings_select on room_bookings;
create policy room_bookings_select on room_bookings
  for select to authenticated using (true);
drop policy if exists room_bookings_update on room_bookings;
create policy room_bookings_update on room_bookings
  for update to authenticated using (true) with check (true);
drop policy if exists room_bookings_delete on room_bookings;
create policy room_bookings_delete on room_bookings
  for delete to authenticated using (true);

-- ------------------------------------------------------------
-- 6) 重なりの判定
--
-- 🚨 画面側のチェックだけでは二重予約は防げない。
--    2人が同じ空き枠を同時に見て同時に保存すると、両方とも「空いている」と判定して
--    すり抜ける。必ずこの関数（＝DB内・ロック付き）を通して確定させること。
--
-- 判定内容:
--   ① 既存に exclusive の予約が1件でも重なっていれば不可（占有）
--   ② これから入れるのが exclusive なら、重なりが1件でもあれば不可
--   ③ どちらでもなければ、重なっている件数が capacity 未満なら可
--
-- 時間の重なりは [starts_at, ends_at) の半開区間で見る。
-- 10:00-11:00 と 11:00-12:00 は「重ならない」＝連続して入れられる。
-- ------------------------------------------------------------
create or replace function room_check_conflict(
  p_floor_id  uuid,
  p_starts_at timestamptz,
  p_ends_at   timestamptz,
  p_exclusive boolean,
  p_exclude_id uuid default null   -- 変更時に自分自身を数えないため
)
returns table (ok boolean, reason text, conflicts jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_capacity   int;
  v_overlap    int;
  v_has_excl   boolean;
  v_list       jsonb;
begin
  select capacity into v_capacity from room_floors where id = p_floor_id;
  if v_capacity is null then
    return query select false, 'この場所は見つかりませんでした', '[]'::jsonb;
    return;
  end if;

  select
    count(*),
    coalesce(bool_or(b.exclusive), false),
    coalesce(jsonb_agg(jsonb_build_object(
      'id', b.id, 'booker', b.booker_name, 'purpose', b.purpose,
      'starts_at', b.starts_at, 'ends_at', b.ends_at, 'exclusive', b.exclusive
    ) order by b.starts_at), '[]'::jsonb)
  into v_overlap, v_has_excl, v_list
  from room_bookings b
  where b.floor_id = p_floor_id
    and b.deleted_at is null
    and b.status = 'active'
    and (p_exclude_id is null or b.id <> p_exclude_id)
    and b.starts_at < p_ends_at
    and b.ends_at   > p_starts_at;

  if v_has_excl then
    return query select false, '占有の予約が入っているため、この時間は使えません', v_list;
  elsif p_exclusive and v_overlap > 0 then
    return query select false, '占有で取るには、先に入っている予約と重ならない時間にしてください', v_list;
  elsif v_overlap >= v_capacity then
    return query select false,
      format('この時間はすでに %s 件入っており、同時に入れられるのは %s 件までです', v_overlap, v_capacity),
      v_list;
  else
    return query select true, null::text, v_list;
  end if;
end $$;

-- ------------------------------------------------------------
-- 7) 予約を作る（重なり判定つき）
--
-- 🚨 pg_advisory_xact_lock でフロア単位に直列化してから数える。
--    これが無いと「2人が同時に3件目を入れて4件になる」競合が起きる。
--    ロックはトランザクション終了で自動的に解放される。
-- ------------------------------------------------------------
create or replace function room_create_booking(
  p_floor_id       uuid,
  p_starts_at      timestamptz,
  p_ends_at        timestamptz,
  p_purpose        text,
  p_booker_name    text,
  p_member_no      text default null,
  p_customer_label text default null,
  p_memo           text default null,
  p_exclusive      boolean default false,
  p_recurrence_id  uuid default null
)
returns table (ok boolean, reason text, booking_id uuid, conflicts jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ok    boolean;
  v_why   text;
  v_list  jsonb;
  v_id    uuid;
begin
  if p_ends_at <= p_starts_at then
    return query select false, '終了は開始より後にしてください', null::uuid, '[]'::jsonb;
    return;
  end if;

  -- フロアIDから作った番号で排他ロック（同じフロアへの同時書き込みだけを直列化する）
  perform pg_advisory_xact_lock(hashtextextended(p_floor_id::text, 0));

  select c.ok, c.reason, c.conflicts into v_ok, v_why, v_list
  from room_check_conflict(p_floor_id, p_starts_at, p_ends_at, p_exclusive, null) c;

  if not v_ok then
    return query select false, v_why, null::uuid, v_list;
    return;
  end if;

  insert into room_bookings (
    floor_id, starts_at, ends_at, purpose, booker_name,
    member_no, customer_label, memo, exclusive, recurrence_id, created_by
  ) values (
    p_floor_id, p_starts_at, p_ends_at, p_purpose, p_booker_name,
    nullif(p_member_no, ''), nullif(p_customer_label, ''), nullif(p_memo, ''),
    p_exclusive, p_recurrence_id, auth.uid()
  ) returning id into v_id;

  return query select true, null::text, v_id, '[]'::jsonb;
end $$;

-- ------------------------------------------------------------
-- 8) 予約を変更する（重なり判定つき・自分自身は除外して数える）
-- ------------------------------------------------------------
create or replace function room_update_booking(
  p_id             uuid,
  p_starts_at      timestamptz,
  p_ends_at        timestamptz,
  p_purpose        text,
  p_booker_name    text,
  p_member_no      text default null,
  p_customer_label text default null,
  p_memo           text default null,
  p_exclusive      boolean default false
)
returns table (ok boolean, reason text, conflicts jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_floor uuid;
  v_ok    boolean;
  v_why   text;
  v_list  jsonb;
begin
  select floor_id into v_floor from room_bookings where id = p_id and deleted_at is null;
  if v_floor is null then
    return query select false, 'この予約は見つかりませんでした（すでに削除された可能性があります）', '[]'::jsonb;
    return;
  end if;
  if p_ends_at <= p_starts_at then
    return query select false, '終了は開始より後にしてください', '[]'::jsonb;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_floor::text, 0));

  select c.ok, c.reason, c.conflicts into v_ok, v_why, v_list
  from room_check_conflict(v_floor, p_starts_at, p_ends_at, p_exclusive, p_id) c;

  if not v_ok then
    return query select false, v_why, v_list;
    return;
  end if;

  update room_bookings set
    starts_at = p_starts_at, ends_at = p_ends_at, purpose = p_purpose,
    booker_name = p_booker_name, member_no = nullif(p_member_no, ''),
    customer_label = nullif(p_customer_label, ''), memo = nullif(p_memo, ''),
    exclusive = p_exclusive, updated_by = auth.uid(), updated_at = now()
  where id = p_id;

  return query select true, null::text, '[]'::jsonb;
end $$;

-- ------------------------------------------------------------
-- 9) 初期データ（2026-08-28 ユーザー確定分）
--    校名は master_options(category='workplace') の表記に合わせている。
--    四条本校は 3階/5階/会議室。他4校は「全体」1つ。
--    同時に入れられる件数はフロアごとに違う（2026-08-28 ユーザー確定）:
--      3階・5階・他4校の全体 … 3件（先生3組が同時に使える）
--      四条本校の会議室       … 1件（1組で使い切る部屋のため）
--    営業時間は四条本校の 9:30〜20:00 をベースに全校同じ値で入れておく
--    （校ごとに違う場合は管理画面から変更する）。
-- ------------------------------------------------------------
insert into room_campuses (name, open_time, close_time, sort_order) values
  ('四条本校',  '09:30', '20:00', 1),
  ('西陣校',    '09:30', '20:00', 2),
  ('上桂校',    '09:30', '20:00', 3),
  ('洛西口校',  '09:30', '20:00', 4),
  ('南草津校',  '09:30', '20:00', 5)
on conflict (name) do nothing;

insert into room_floors (campus_id, name, capacity, sort_order)
select c.id, f.name, f.cap, f.ord
from room_campuses c
join (values
  ('四条本校', '3階',   3, 1),
  ('四条本校', '5階',   3, 2),
  ('四条本校', '会議室', 1, 3),   -- 会議室だけ同時1件（1組で使い切るため）
  ('西陣校',   '全体',  3, 1),
  ('上桂校',   '全体',  3, 1),
  ('洛西口校', '全体',  3, 1),
  ('南草津校', '全体',  3, 1)
) as f(campus, name, cap, ord) on f.campus = c.name
on conflict (campus_id, name) do nothing;
