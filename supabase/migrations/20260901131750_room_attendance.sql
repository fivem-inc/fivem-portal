-- ============================================================
-- 場所予約：出欠を記録できるようにする（2026-09-01 ユーザー指示）
--
-- なぜ「予約の列」ではなく別の表にするのか:
--   🚨 いまの作りは、**1件の予約に参加者が複数ぶら下がる**。
--      募集枠を2名定員にすると room_fill_open_slot が会員番号とお名前を
--      「田中 太郎, 佐藤 花子」のようにカンマでつないで1行に入れる。
--      予約に出欠の列を1つ足すと「片方だけ欠席」が記録できない。
--   ・参加者の表を作って正規化する案もあったが、中心の RPC
--     （room_fill_open_slot）の書き換えと既存データの移行が要るため見送った。
--     **出欠だけ別の表にすれば、RPCも予約本体も触らずに済む**（ユーザー確定）。
--
-- ------------------------------------------------------------
-- ① 出欠の選択肢（画面から足せる）
-- ------------------------------------------------------------
--   🚨 コードに固定しないこと。あとで「振替」等を足すのにデプロイが要るため
--      （用途詳細と同じ考え方・2026-09-01 ユーザー確定）。
--   purposes … 空(null) = 全用途で出す。値が入っていればその用途だけ
--              例：「連絡なし休み」は {パーソナル} のみ
--
-- ロールバック手順:
--   drop table if exists room_booking_attendance;
--   drop table if exists room_attendance_options;
-- ============================================================

create table if not exists room_attendance_options (
  id             uuid primary key default gen_random_uuid(),
  name           text    not null unique,          -- 画面に出るボタンの文字
  -- 出席として数えるか。🚨 「キャン1回消化」は来ていないが出席扱い（ユーザー指示）
  counts_present boolean not null default false,
  -- どの用途で出すか。null = 全用途
  purposes       text[],
  sort_order     int     not null default 0,
  active         boolean not null default true,    -- false = 出さない（消さずに隠す）
  updated_at     timestamptz not null default now(),
  updated_by     uuid references auth.users(id)
);

alter table room_attendance_options enable row level security;

drop policy if exists room_attendance_options_select on room_attendance_options;
create policy room_attendance_options_select on room_attendance_options
  for select to authenticated using (true);

drop policy if exists room_attendance_options_write on room_attendance_options;
create policy room_attendance_options_write on room_attendance_options
  for all to authenticated
  using (room_is_staff())
  with check (room_is_staff());

-- ------------------------------------------------------------
-- ② 出欠の記録（付けたときだけ行ができる）
-- ------------------------------------------------------------
--   participant_no / participant_name … カンマでつながった参加者を画面側で分けたもの。
--     🚨 会員番号が無い一般のお客様もいるので、**番号だけを鍵にしない**。
--        番号とお名前の組で1人と数える。
--   status … 選んだ出欠の**名前をそのまま**保存する。
--     🚨 選択肢の行を指すのではなく名前で持つ。あとで選択肢を消しても
--        過去の記録が読めなくならないようにするため。
--   counted_present … **記録した時点で出席扱いだったか**を写し取る。
--     🚨 あとで選択肢の「出席扱い」を変えても、**過去の集計が勝手に変わらない**ようにする。
create table if not exists room_booking_attendance (
  id               uuid primary key default gen_random_uuid(),
  booking_id       uuid not null references room_bookings(id) on delete cascade,
  participant_no   text not null default '',       -- 会員番号（無ければ空）
  participant_name text not null default '',       -- お名前（無ければ空）
  status           text not null,
  counted_present  boolean not null default false,
  recorded_at      timestamptz not null default now(),
  recorded_by      uuid references auth.users(id)
);

-- 🚨 同じ参加者に2つ付けさせない（付け直しは upsert で上書きする）
create unique index if not exists idx_room_booking_attendance_uniq
  on room_booking_attendance (booking_id, participant_no, participant_name);

-- 一覧は「この予約の出欠」を引く形しかない
create index if not exists idx_room_booking_attendance_booking
  on room_booking_attendance (booking_id);

alter table room_booking_attendance enable row level security;

drop policy if exists room_booking_attendance_select on room_booking_attendance;
create policy room_booking_attendance_select on room_booking_attendance
  for select to authenticated using (true);

drop policy if exists room_booking_attendance_write on room_booking_attendance;
create policy room_booking_attendance_write on room_booking_attendance
  for all to authenticated
  using (room_is_staff())
  with check (room_is_staff());

-- ------------------------------------------------------------
-- ③ 初期の選択肢（2026-09-01 ユーザー指定）
--    これ以降は画面（基本設定 → 出欠の選択肢）から足せる
-- ------------------------------------------------------------
insert into room_attendance_options (name, counts_present, purposes, sort_order) values
  ('出席',          true,  null,             1),
  ('キャンセル料',  false, null,             2),
  ('キャン1回消化', true,  null,             3),
  ('休み',          false, null,             4),
  ('連絡なし休み',  false, '{パーソナル}',   5)
on conflict (name) do nothing;

-- 確認用:
--   select name, counts_present, purposes, sort_order, active
--     from room_attendance_options order by sort_order;
--   select count(*) from room_booking_attendance;
