-- ============================================================
-- 場所予約：お客様の情報（2026-08-29 ユーザー確定）
--
-- 何をするものか:
--   スコラプラスから出したデータを取り込み、予約フォームで会員番号を
--   入れたときにお名前が自動で出るようにする。
--
-- なぜ必要か:
--   いま参加者は手打ちの表示名だけ。「田中様／田中さま」と揺れると
--   参加者別の集計で別人になる。会員番号から名前を引ければ揺れが消える。
--
-- 🚨 一般の方（非会員）もいる（ユーザー指摘）。
--    会員番号で見つからないときは、これまでどおり名前を手入力する。
--    見つからない＝エラーではない。画面でも「一般のお客様」として扱う。
--
-- 学年について:
--   学年は持たず、**生年月日から計算する**（ユーザー確定）。
--   持ってしまうと4月に全員1つズレ、上げ忘れると静かに間違い続けるため。
--   🚨 日本の学年は「4/2〜翌4/1 生まれ」で1学年。**4/1生まれは1つ上**。
--      計算は client/src/lib/roomBooking.ts の schoolGrade() に集約する。
--
-- 連絡先の見える範囲:
--   room_settings の 'contact_visibility' で決める（ユーザー指示で後から変更可）。
--     'admin' … 管理者のみ ／ 'staff' … 社員まで（既定） ／ 'all' … ログイン者全員
--   列ごとの制限は素直に書けないので、**連絡先だけ別テーブル**にしている。
--   範囲を変えるときは設定値を変えるだけでよく、ポリシーは書き換えない。
--
-- 🚨 このリポジトリは Public。取り込んだお客様のデータを、この
--    マイグレーションや他のコードに書かないこと。データはDBにだけ置く。
--
-- ロールバック手順:
--   drop table if exists room_customer_contacts;
--   drop table if exists room_customers;
--   drop function if exists room_can_see_contacts();
--   delete from room_settings where key = 'contact_visibility';
-- ============================================================

-- ------------------------------------------------------------
-- 1) 設定（あとから変えたい値の置き場）
-- ------------------------------------------------------------
create table if not exists room_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id)
);

alter table room_settings enable row level security;

-- 読みは全員（画面が「連絡先を出してよいか」を知る必要がある）
drop policy if exists room_settings_select on room_settings;
create policy room_settings_select on room_settings
  for select to authenticated using (true);

-- 書きは管理者のみ。見える範囲を決める設定なので、日常設定とは分ける
drop policy if exists room_settings_write on room_settings;
create policy room_settings_write on room_settings
  for all to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

insert into room_settings (key, value) values ('contact_visibility', 'staff')
on conflict (key) do nothing;

-- 「基本設定」を使える役職（2026-08-31 ユーザー確定・案A）。
-- カンマ区切りの役職名。既定はパート以外すべて＝いままでと同じ動き。
-- 🚨 「リーダー以上」のような序列では持たない。フロア責任者をどちら側に
--    含めるかで過去に判断が割れており、序列にすると同じ罠を踏むため
--    （CLAUDE.md「役職序列」参照）。役職名を並べて持つ。
insert into room_settings (key, value)
values ('basic_settings_roles', '一般,リーダー,フロア責任者,マネージャー,社長,管理者')
on conflict (key) do nothing;

/**
 * 「基本設定」を使ってよいか。
 *   ・パートは常に不可
 *   ・管理者は設定に関わらず常に可（自分を締め出せないようにする）
 *   ・それ以外は basic_settings_roles に自分の役職が入っていれば可
 * 設定が無いときは「パートでなければ可」＝これまでの動きに倒す。
 *
 * 🚨 画面だけで絞らないこと。ここでも同じ判定をするので、
 *    「ボタンは出ないのに実は書き込めた」が起きない。
 */
create or replace function room_can_use_basic_settings() returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' then true
    when not room_is_staff() then false
    else exists (
      select 1 from profiles p
       where p.id = auth.uid()
         and coalesce(p.role_title, '') = any (
           string_to_array(
             coalesce((select value from room_settings where key = 'basic_settings_roles'),
                      '一般,リーダー,フロア責任者,マネージャー,社長,管理者'),
             ','))
    )
  end;
$$;

-- ------------------------------------------------------------
-- 2) お客様（名前・生年月日）。ここは予約表に出すので広く読める
-- ------------------------------------------------------------
create table if not exists room_customers (
  member_no    text primary key,           -- スコラプラスの会員番号
  display_name text not null,              -- 予約表に出す名前（例「田中様」）
  full_name    text,                       -- 氏名（取り込んだそのまま）
  birth_date   date,                       -- 学年はここから計算する
  active       boolean not null default true,  -- 退会しても消さない
  note         text,
  imported_at  timestamptz,
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users(id)
);

create index if not exists idx_room_customers_name
  on room_customers (display_name) where active;

alter table room_customers enable row level security;

drop policy if exists room_customers_select on room_customers;
create policy room_customers_select on room_customers
  for select to authenticated using (true);

-- 取り込み・修正は社員まで
drop policy if exists room_customers_write on room_customers;
create policy room_customers_write on room_customers
  for all to authenticated
  using (room_can_use_basic_settings())
  with check (room_can_use_basic_settings());

-- ------------------------------------------------------------
-- 3) 連絡先。見える範囲を設定で変えられるように別テーブルにする
-- ------------------------------------------------------------
create table if not exists room_customer_contacts (
  member_no     text primary key references room_customers(member_no) on delete cascade,
  phone         text,
  email         text,
  guardian_name text,
  updated_at    timestamptz not null default now(),
  updated_by    uuid references auth.users(id)
);

alter table room_customer_contacts enable row level security;

/**
 * 連絡先を見てよいか。設定値 'contact_visibility' で決まる。
 * 設定が無い・知らない値のときは 'staff'（社員まで）として扱う＝広げない側に倒す。
 */
create or replace function room_can_see_contacts() returns boolean
language sql stable security definer set search_path = public as $$
  select case coalesce((select value from room_settings where key = 'contact_visibility'), 'staff')
           when 'all'   then auth.uid() is not null
           when 'admin' then (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
           else room_is_staff()
         end;
$$;

drop policy if exists room_customer_contacts_select on room_customer_contacts;
create policy room_customer_contacts_select on room_customer_contacts
  for select to authenticated using (room_can_see_contacts());

-- 書きは社員まで。取り込みは名前・生年月日と一緒に来るため（ユーザー指示）、
-- 見える範囲を管理者のみに絞っていても、取り込み自体は社員ができる
drop policy if exists room_customer_contacts_write on room_customer_contacts;
create policy room_customer_contacts_write on room_customer_contacts
  for all to authenticated
  using (room_can_use_basic_settings())
  with check (room_can_use_basic_settings());
