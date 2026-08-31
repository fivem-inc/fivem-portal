-- ============================================================
-- 場所予約：担当スタッフとレッスン区分（2026-08-28 追加指示）
--
-- 追加する理由:
--   予約に「誰が担当するか」を持たせ、スタッフ別のスケジュールを出せるようにする。
--   あわせて、社内で使われている A〜E のレッスン区分をマスタとして持ち、
--   スタッフごとの担当可能範囲を表示する（🚨 制限はしない・表示だけ）。
--
-- 🚨 すべて管理画面から後から追加・変更できる形にすること（ユーザー指示）。
--    スタッフの増減・区分の追加・担当範囲の変更は日常的に起きるため、
--    そのたびに開発者へ依頼する運用にしない。
--
-- ロールバック手順（逆順）:
--   alter table room_bookings   drop column staff_id;
--   alter table room_recurrences drop column staff_id;
--   drop table if exists room_staff_categories;
--   drop table if exists room_staff;
--   drop table if exists room_lesson_categories;
-- ============================================================

-- ------------------------------------------------------------
-- 1) レッスン区分（A〜E）
--    記号(code)と説明(description)を分けて持つ。画面は記号で出し、
--    説明は選ぶときの補足に使う（社内の案内文をそのまま入れている）。
-- ------------------------------------------------------------
create table if not exists room_lesson_categories (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,          -- 'A' 'B' …（後から F 以降も足せる）
  description text not null default '',
  sort_order  int  not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 2) スタッフ
--    ログインアカウント(auth.users)と結び付けられるが、必須にしない。
--    🚨 外部の先生などアカウントを持たない人も登録できる必要があるため
--       user_id は nullable。名前(name)が画面に出る唯一の識別子。
-- ------------------------------------------------------------
create table if not exists room_staff (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,           -- 例 '林 晃平'
  user_id    uuid references auth.users(id) on delete set null,
  sort_order int  not null default 0,
  active     boolean not null default true,  -- 退職者は false で選択肢から外す（過去の予約は残る）
  created_at timestamptz not null default now()
);
create index if not exists idx_room_staff_active on room_staff (active, sort_order);

-- ------------------------------------------------------------
-- 3) スタッフごとの担当可能範囲（多対多）
-- ------------------------------------------------------------
create table if not exists room_staff_categories (
  staff_id    uuid not null references room_staff(id) on delete cascade,
  category_id uuid not null references room_lesson_categories(id) on delete cascade,
  primary key (staff_id, category_id)
);

-- ------------------------------------------------------------
-- 4) 予約に担当スタッフを持たせる
--    🚨 on delete set null にする。スタッフを消しても予約そのものは消さない
--       （予約が消えると「その時間が空いた」ことになり、実態と食い違う）。
-- ------------------------------------------------------------
alter table room_bookings    add column if not exists staff_id uuid references room_staff(id) on delete set null;
alter table room_recurrences add column if not exists staff_id uuid references room_staff(id) on delete set null;
create index if not exists idx_room_bookings_staff on room_bookings (staff_id, starts_at) where deleted_at is null;

-- ------------------------------------------------------------
-- 5) RLS（既存の room_* と同じ方針：ログイン済みなら全員が読み書き）
-- ------------------------------------------------------------
alter table room_lesson_categories enable row level security;
alter table room_staff             enable row level security;
alter table room_staff_categories  enable row level security;

drop policy if exists room_lesson_categories_all on room_lesson_categories;
create policy room_lesson_categories_all on room_lesson_categories
  for all to authenticated using (true) with check (true);

drop policy if exists room_staff_all on room_staff;
create policy room_staff_all on room_staff
  for all to authenticated using (true) with check (true);

drop policy if exists room_staff_categories_all on room_staff_categories;
create policy room_staff_categories_all on room_staff_categories
  for all to authenticated using (true) with check (true);

-- ------------------------------------------------------------
-- 6) 予約を作る関数に担当スタッフを追加
--    🚨 既存の呼び出し（p_staff_id なし）でも動くよう既定値 null を付ける。
--       引数を増やすと PostgREST から見て別関数になるため、
--       古い定義を drop してから作り直す（同名の2定義が残ると呼び分けが曖昧になる）。
-- ------------------------------------------------------------
drop function if exists room_create_booking(uuid, timestamptz, timestamptz, text, text, text, text, text, boolean, uuid);

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
  p_recurrence_id  uuid default null,
  p_staff_id       uuid default null
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

  -- フロア単位で直列化（同時に3件目・4件目を入れる競合を防ぐ）
  perform pg_advisory_xact_lock(hashtextextended(p_floor_id::text, 0));

  select c.ok, c.reason, c.conflicts into v_ok, v_why, v_list
  from room_check_conflict(p_floor_id, p_starts_at, p_ends_at, p_exclusive, null) c;

  if not v_ok then
    return query select false, v_why, null::uuid, v_list;
    return;
  end if;

  insert into room_bookings (
    floor_id, starts_at, ends_at, purpose, booker_name,
    member_no, customer_label, memo, exclusive, recurrence_id, staff_id, created_by
  ) values (
    p_floor_id, p_starts_at, p_ends_at, p_purpose, p_booker_name,
    nullif(p_member_no, ''), nullif(p_customer_label, ''), nullif(p_memo, ''),
    p_exclusive, p_recurrence_id, p_staff_id, auth.uid()
  ) returning id into v_id;

  return query select true, null::text, v_id, '[]'::jsonb;
end $$;

-- ------------------------------------------------------------
-- 7) 予約を変更する関数にも担当スタッフを追加
-- ------------------------------------------------------------
drop function if exists room_update_booking(uuid, timestamptz, timestamptz, text, text, text, text, text, boolean);

create or replace function room_update_booking(
  p_id             uuid,
  p_starts_at      timestamptz,
  p_ends_at        timestamptz,
  p_purpose        text,
  p_booker_name    text,
  p_member_no      text default null,
  p_customer_label text default null,
  p_memo           text default null,
  p_exclusive      boolean default false,
  p_staff_id       uuid default null
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
    exclusive = p_exclusive, staff_id = p_staff_id,
    updated_by = auth.uid(), updated_at = now()
  where id = p_id;

  return query select true, null::text, '[]'::jsonb;
end $$;

-- ------------------------------------------------------------
-- 8) 初期データ（2026-08-28 ユーザー提供）
--    説明文は社内のご案内文をそのまま入れている。
--    区分の追加・文言の修正・スタッフの増減は管理画面から行う。
-- ------------------------------------------------------------
insert into room_lesson_categories (code, description, sort_order) values
  ('A', '跳び箱（開脚・閉脚跳び等）・マット（前転・後転・側転・倒立・ロンダート等）・鉄棒（逆上がり・後回り・前回り等）・ストレッチ・トレーニング', 1),
  ('B', '跳び箱（ヘッド転回・転回等）・マット（転回・バク転※小学生まで）・鉄棒（ひこうきとび等）', 2),
  ('C', 'バク転※中学生以上・宙返り・側宙等、アクロバット系の技', 3),
  ('D', 'なわとび・ボール投げ・ボールつき・受験対策等', 4),
  ('E', '走力向上（走り方・ハードル・ラダー）', 5)
on conflict (code) do nothing;

insert into room_staff (name, sort_order) values
  ('林 晃平',     1),  ('長岡 貴子',   2),  ('太田 英次朗', 3),  ('清水 治彦',   4),
  ('小川 美保',   5),  ('小出 勇輝',   6),  ('栗木 佑典',   7),  ('鈴木 雅',     8),
  ('西村 友彦',   9),  ('阿部 広実',  10),  ('馬場 古都音', 11),  ('森本 純矢',  12),
  ('幾田 花',    13),  ('成田 彬文',  14),  ('川井 玲',    15),  ('尾上 千佳子', 16)
on conflict (name) do nothing;

insert into room_staff_categories (staff_id, category_id)
select s.id, c.id
from room_staff s
join (values
  ('林 晃平',     'ABCDE'),
  ('長岡 貴子',   'ABD'),
  ('太田 英次朗', 'ABCD'),
  ('清水 治彦',   'ABCD'),
  ('小川 美保',   'ABD'),
  ('小出 勇輝',   'ABCDE'),
  ('栗木 佑典',   'ABCDE'),
  ('鈴木 雅',     'ABD'),
  ('西村 友彦',   'ABCDE'),
  ('阿部 広実',   'ABD'),
  ('馬場 古都音', 'ABD'),
  ('森本 純矢',   'ABCD'),
  ('幾田 花',     'ABDE'),
  ('成田 彬文',   'ABD'),
  ('川井 玲',     'AB'),
  ('尾上 千佳子', 'ABD')
) as m(name, codes) on m.name = s.name
join room_lesson_categories c on position(c.code in m.codes) > 0
on conflict do nothing;
