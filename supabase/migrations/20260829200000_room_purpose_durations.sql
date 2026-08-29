-- ============================================================
-- 場所予約：用途ごとの「長さ」の選択肢（2026-08-29 ユーザー確定）
--
-- 何をするものか:
--   予約フォームの「長さ」ボタンを、用途ごとに変える。
--     プライベート … 25分 / 30分 / 50分 ＋ 任意
--     パーソナル   … 10分のみ
--     レッスン     … 50分のみ
--     レンタル     … 1時間 / 2時間 ＋ 任意
--     その他       … 任意のみ
--
-- 設計の判断:
--   ・**コードに直接書かない**。ユーザーから「表示項目は社員が変更できるように」
--     と指示があったため、DBに置いて画面から直せるようにする。
--     ここを固定にすると、時間が変わるたびに開発者へ依頼することになる。
--   ・用途1つにつき1行。選択肢は int[] で持つ。
--     行を分けて持つと、並び順の列と削除の後始末が要るわりに、
--     実際には「まとめて入れ替える」使い方しかしないため。
--   ・allow_free … 終了時刻を手で入れてよいか。
--     パーソナル(10分)・レッスン(50分)のように長さが決まっているものは false。
--     false のときは終了時刻を自動計算にして、打ち間違いを防ぐ。
--     🚨 あとから「やっぱり任意も要る」となっても、画面から直せる。
--
-- 権限:
--   読み … ログインしていれば全員（予約フォームを開く全員が必要）
--   書き … 社員のみ（room_is_staff）。20260829100000 の関数を使う。
--   🚨 他のマスタ（場所・スタッフ・区分）の「書きは管理者のみ」の
--      ポリシーには触っていない。
--
-- ロールバック手順:
--   drop table if exists room_purpose_durations;
-- ============================================================

create table if not exists room_purpose_durations (
  purpose     text primary key,
  -- 選べる長さ（分）。空配列 = ボタンを出さない（＝任意入力だけ）
  minutes     int[]   not null default '{}',
  -- 終了時刻を手で入れてよいか
  allow_free  boolean not null default true,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references auth.users(id)
);

alter table room_purpose_durations enable row level security;

-- 読みは全員（予約フォームで必ず要る）
drop policy if exists room_purpose_durations_select on room_purpose_durations;
create policy room_purpose_durations_select on room_purpose_durations
  for select to authenticated using (true);

-- 書きは社員のみ
drop policy if exists room_purpose_durations_write on room_purpose_durations;
create policy room_purpose_durations_write on room_purpose_durations
  for all to authenticated
  using (room_is_staff())
  with check (room_is_staff());

-- 初期値（2026-08-29 ユーザー指定）
insert into room_purpose_durations (purpose, minutes, allow_free) values
  ('プライベート', '{25,30,50}', true),
  ('パーソナル',   '{10}',       false),
  ('レッスン',     '{50}',       false),
  ('レンタル',     '{60,120}',   true),
  ('その他',       '{}',         true)
on conflict (purpose) do nothing;
