-- 備品購入申請・経費精算機能 Phase 1（精算フローのみ）
--
-- 将来的に request_type='purchase_request'（金額に応じた承認ルート付きの新規購入申請）を
-- 追加する予定があるが、今回は 'reimbursement'（承認ゲートなしの実費精算）のみ実装する。
-- request_type の CHECK 制約はガードとして絞ってあり、Phase 2 実装時に緩める。

create table public.purchase_requests (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null references auth.users(id) on delete cascade,
  applicant_role_title text not null,  -- 申請時点の役職スナップショット（後で役職が変わっても履歴は残る）

  request_type text not null default 'reimbursement' check (request_type in ('reimbursement')),

  item_name text not null,
  quantity integer,
  amount integer not null check (amount >= 0),
  purchased_at date not null,
  instructed_by text,     -- 指示者（誰からの依頼か）
  store_name text,        -- 購入先（店舗名）
  purpose text,           -- 用途・使用先
  payment_method text not null check (payment_method in ('cash', 'company_card')),
  notes text,

  receipt_type text not null check (receipt_type in ('photo', 'physical', 'none')),
  receipt_missing_reason text,
  receipt_storage_path text,
  check (receipt_type != 'none' or receipt_missing_reason is not null),

  status text not null default 'recorded' check (status in ('recorded')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index idx_purchase_requests_user on public.purchase_requests(user_id);
create index idx_purchase_requests_status on public.purchase_requests(status);

create or replace function public.update_purchase_requests_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger purchase_requests_updated_at
  before update on public.purchase_requests
  for each row execute function public.update_purchase_requests_updated_at();

alter table public.purchase_requests enable row level security;

-- 本人は自分の記録をinsert/select
create policy "pr_applicant_select" on public.purchase_requests
  for select using (user_id = auth.uid());
create policy "pr_applicant_insert" on public.purchase_requests
  for insert with check (user_id = auth.uid());

-- マネージャー以上・管理者は全件参照（記録の把握のため）
create policy "pr_manager_plus_select" on public.purchase_requests
  for select using (
    (auth.jwt() ->> 'role') = 'admin'
    or exists (select 1 from profiles where id = auth.uid() and role_title in ('マネージャー', '社長'))
  );

create policy "pr_admin_all" on public.purchase_requests
  for all using ((auth.jwt() ->> 'role') = 'admin');

-- ========================================
-- Supabase Storage: レシート写真用バケット（本アプリ初導入）
-- パス規約: {user_id}/{request_id}/{timestamp}_receipt.jpg
-- Storage RLSは所有者チェックのみに留め、マネージャー以上の閲覧は
-- purchase_requests側のRLSを前提にサーバー側（Edge Function）で署名URLを発行する方式にする
-- （テーブルRLSとStorage RLSでロール判定ロジックを二重管理しないため）
-- ========================================
insert into storage.buckets (id, name, public)
values ('purchase-receipts', 'purchase-receipts', false)
on conflict (id) do nothing;

create policy "purchase_receipts_insert_own"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'purchase-receipts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "purchase_receipts_select_own"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'purchase-receipts'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ========================================
-- 機能公開範囲: feature_permissions に purchase_request を追加
-- 全ロールを一旦 false で登録し、実際の段階公開（社長のみ→三役→全公開）は
-- ユーザーが管理画面 FeaturePermissionsTab から都度操作する
-- ========================================
insert into public.feature_permissions (role_id, feature_key, enabled)
select id, 'purchase_request', false from public.roles
on conflict (role_id, feature_key) do nothing;

-- ========================================
-- 通知設定: 精算記録時にマネージャー以上へ軽量なsite通知のみ（email/slackは今回見送り）
-- ========================================
insert into notification_settings (event_key, channel, enabled, recipient, subject, template) values
  ('purchase:reimbursement_recorded', 'site', true,
    '{"roles":["マネージャー","社長","管理者"],"groupFilter":"none"}',
    null,
    E'🧾 {{申請者名}}さんが精算記録を追加しました（{{品目名}}・¥{{金額}}）')
on conflict (event_key, channel) do nothing;
