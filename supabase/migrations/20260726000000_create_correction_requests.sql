-- ========================================
-- 申請（休暇/勤務変更/残業）の「修正依頼」
--   本人が申請後（主に受理済み）に、管理者へ「ここをこう直してほしい」と依頼する。
--   横断1テーブル（target_type/target_id でポリモーフィック参照）。
--   本体の申請テーブルとは別ライフサイクル（open→resolved/declined）を持つため、
--   既存の *_history（不変の監査ログ）には相乗りさせない。
-- 追加のみ・既存データ無傷。
-- ========================================

-- 管理者判定を1関数に集約（★app_metadata->>'role' が唯一の正。
--  旧 (auth.jwt()->>'role') は 'authenticated' が返り 42501 で全滅するので絶対に使わない）
create or replace function is_admin() returns boolean
language sql stable
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
$$;

-- notifications に参照列が無ければ足す（本番はSQL Editorで追加済みの場合あり＝冪等）。
-- RPCのベル通知insertがこれらの列を使うため、欠けていると原子的insertが失敗する。
-- ⚠️ reference_id は必ず text にする。本番の実列は text（2026-06-16 に db query で追加）で、
--    attendance の通知は日付文字列（YYYY-MM-DD）を入れている。ここを uuid で書くと
--    本番では if not exists で素通り（無害）だが、新規DB構築時に uuid 列が作られ、
--    日付を入れる通知（attendance/FYI）が invalid input syntax で全滅する時限爆弾になる。
alter table notifications add column if not exists reference_id text;
alter table notifications add column if not exists event_key text;

create table if not exists correction_requests (
  id uuid primary key default gen_random_uuid(),
  target_type text not null check (target_type in ('leave','shift','overtime')),
  target_id uuid not null,                                   -- 論理FK：target_typeごとに参照先テーブルが決まる（物理FKは張れない）
  requester_id uuid not null references auth.users(id) on delete cascade,
  request_kind text not null default 'edit'                  -- edit=内容を直してほしい / cancel=取り消してほしい
    check (request_kind in ('edit','cancel')),
  message text not null,                                     -- 直したい内容の自由記述（補足）
  requested_changes jsonb,                                   -- 構造化した希望値 { field: {old,new} }（任意）
  status text not null default 'open'
    check (status in ('open','resolved','declined','withdrawn')),  -- withdrawn=本人が取り下げ
  admin_reply text,                                          -- 対応不可時などの管理者コメント
  resolved_by uuid references auth.users(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now()
);

alter table correction_requests enable row level security;

-- 同一申請に open な依頼は1件まで（本人の二重送信・多重押しをDBで確実に防ぐ）
create unique index if not exists correction_requests_one_open
  on correction_requests (target_type, target_id) where status = 'open';

create index if not exists correction_requests_status_idx
  on correction_requests (status, created_at desc);
create index if not exists correction_requests_requester_idx
  on correction_requests (requester_id, created_at desc);

-- SELECT：本人 or 管理者
drop policy if exists correction_requests_owner_select on correction_requests;
create policy correction_requests_owner_select on correction_requests
  for select using (requester_id = auth.uid());
drop policy if exists correction_requests_admin_select on correction_requests;
create policy correction_requests_admin_select on correction_requests
  for select using (is_admin());

-- UPDATE：管理者のみ（本人の直接更新は不可。resolve/decline は SECURITY DEFINER RPC 経由）
drop policy if exists correction_requests_admin_update on correction_requests;
create policy correction_requests_admin_update on correction_requests
  for update using (is_admin()) with check (is_admin());

-- INSERT ポリシーは作らない（＝ submit_correction_request RPC 経由のみ。所有チェックをRPCに一元化）
