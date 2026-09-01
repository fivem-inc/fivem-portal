-- ============================================================
-- 場所予約：用途の「詳細」（パーソナルの 体操・筋トレ など）を
--            管理者が追加・編集できるようにする
--            （2026-09-01 ユーザー指示）
--
-- なぜ用途ごとにぶら下げるのか:
--   ・「パーソナル専用」で作ると、あとで「レッスンにも種目を付けたい」と
--     なったときに作り直しになる。用途をキーにしておけば表1つで足りる。
--   🚨 用途そのものを増やす案（「パーソナル（体操）」等）は採らない。
--      色分け・長さの設定・集計がすべて用途の単位なので、増やすたびに
--      設定が重複して食い違う。
--   🚨 メモ欄に書く案も採らない。表記ゆれで数えられなくなる。
--
-- 必須にするかどうか:
--   room_purpose_durations.detail_required で用途ごとに切り替える
--   （2026-09-01 ユーザー指示：ボタンで変えられるようにし、まずは必須）。
--   🚨 効くのは「その用途に詳細が1つ以上あるとき」だけ。
--      詳細を1つも登録していない用途では、必須でも入力を求めない
--      （そうしないと、詳細を作っていない用途で予約できなくなる）。
--
-- 🚨 既にある予約の detail は空。編集で開くと、必須の用途では
--    詳細を選ぶまで保存できない。今ある予約は少ないので、そのまま進める。
--
-- ロールバック手順:
--   drop table if exists room_purpose_details;
--   alter table room_purpose_durations drop column detail_required;
--   alter table room_bookings drop column detail;
-- ============================================================

-- ① 詳細の一覧 ------------------------------------------------
create table if not exists room_purpose_details (
  id          uuid primary key default gen_random_uuid(),
  purpose     text    not null,               -- どの用途にぶら下がるか
  name        text    not null,               -- 例：体操／筋トレ
  sort_order  int     not null default 0,     -- 予約フォームでの並び順
  active      boolean not null default true,  -- false = 出さない（消さずに隠す）
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id)
);

-- 🚨 同じ用途に同じ名前を2つ作らせない。片方だけ直す事故を防ぐ
create unique index if not exists idx_room_purpose_details_uniq
  on room_purpose_details (purpose, name);

-- 一覧は「この用途の、出すものを並び順で」しか引かない
create index if not exists idx_room_purpose_details_purpose
  on room_purpose_details (purpose, sort_order) where active;

alter table room_purpose_details enable row level security;

-- 読みは全員（予約フォームで必ず要る）
drop policy if exists room_purpose_details_select on room_purpose_details;
create policy room_purpose_details_select on room_purpose_details
  for select to authenticated using (true);

-- 書きは社員のみ（他の場所予約の設定と揃える）
drop policy if exists room_purpose_details_write on room_purpose_details;
create policy room_purpose_details_write on room_purpose_details
  for all to authenticated
  using (room_is_staff())
  with check (room_is_staff());

-- ② 用途ごとに「詳細を必須にするか」 --------------------------
alter table room_purpose_durations
  add column if not exists detail_required boolean not null default true;

-- ③ 予約に詳細を持たせる --------------------------------------
alter table room_bookings
  add column if not exists detail text;

-- 繰り返しの約束事にも持たせる（来年度に引き継ぐときに消えないように）
alter table room_recurrences
  add column if not exists detail text;
-- 🚨 **年度更新（room_renew_recurrence）は、まだ detail を予約にコピーしない。**
--    中心のRPCを書き換えるのは事故が起きやすいため、この回では触っていない。
--    引き継いだ予約の詳細は空になる。対応するときは、必ず本番の実定義から起こすこと：
--      select pg_get_functiondef(p.oid) from pg_proc p
--        join pg_namespace n on n.oid = p.pronamespace
--       where n.nspname='public' and p.proname='room_renew_recurrence';

-- ④ 方針の変更：お客様名はフルネームで入れる（2026-09-01 ユーザー指示）------
--    20260828100000_room_booking.sql には customer_label について
--    「例 '田中様'。フルネーム・連絡先は入れない」と書いてあるが、**この日から
--    フルネームで入れる方針に変わった**。画面の入力例と注意書きも直してある。
--    🚨 連絡先（電話・メール）を入れない点は今までどおり変わらない。
--       予約表は場所予約を使えるスタッフ全員に見えるため。
comment on column room_bookings.customer_label is
  'お客様のお名前。2026-09-01 よりフルネームで入れる（旧：「田中様」形式）。連絡先は入れない';

-- ⑤ 初期値（2026-09-01 ユーザーの挙げた例）--------------------
--    足りないぶんは管理画面「基本設定」から追加できる
insert into room_purpose_details (purpose, name, sort_order) values
  ('パーソナル', '体操',   1),
  ('パーソナル', '筋トレ', 2)
on conflict (purpose, name) do nothing;

-- 確認用:
--   select purpose, name, sort_order, active
--     from room_purpose_details order by purpose, sort_order;
--   select purpose, minutes, default_minutes, allow_free, detail_required
--     from room_purpose_durations order by purpose;
