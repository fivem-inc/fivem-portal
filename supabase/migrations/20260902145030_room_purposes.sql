-- ============================================================
-- 場所予約：用途をテーブルにする（2026-09-02 ユーザー承認・案②）
--
-- これまで用途（プライベート／パーソナル…）はコードに固定だった。
-- 管理者が ⚙️設定 → 用途 で 追加・名前の変更・並び替え・隠す をできるようにする。
--
-- 🚨 削除はできない（隠すだけ）。過去の予約に用途名が文字で残っているため。
-- 🚨 色は自由な色コードではなく、コード側の PURPOSE_PALETTE の鍵
--    （purple / teal / blue / amber / green / rose / indigo / gray）で持つ。
--    暗い画面で読めない色を選ばれないようにするため。
-- 🚨 名前の変更は画面側が 予約・繰り返し・長さ設定・詳細・出欠の対象設定 を
--    まとめて書き換える（用途詳細の名前変更と同じ方式）。
--
-- ロールバック手順:
--   drop table if exists room_purposes;
-- ============================================================

create table if not exists room_purposes (
  id         uuid primary key default gen_random_uuid(),
  name       text not null unique,
  color_key  text not null default 'gray',
  sort_order int  not null default 0,
  active     boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

alter table room_purposes enable row level security;

-- 読みは全員（予約フォームで必ず要る）
drop policy if exists room_purposes_select on room_purposes;
create policy room_purposes_select on room_purposes
  for select to authenticated using (true);

-- 書きは管理者のみ（⚙️設定＝マスタ管理の一部。他のマスタと同じ判定）
drop policy if exists room_purposes_write on room_purposes;
create policy room_purposes_write on room_purposes
  for all to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- 既存の5用途を今までの色で登録（見た目は変わらない）
insert into room_purposes (name, color_key, sort_order) values
  ('プライベート', 'purple', 1),
  ('パーソナル',   'teal',   2),
  ('レッスン',     'blue',   3),
  ('レンタル',     'amber',  4),
  ('その他',       'gray',   5)
on conflict (name) do nothing;

-- 確認用:
--   select name, color_key, sort_order, active from room_purposes order by sort_order;
