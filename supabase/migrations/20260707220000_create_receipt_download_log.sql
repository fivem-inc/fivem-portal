-- レシート画像のダウンロード履歴を記録するテーブル
-- 経理監査目的：誰が・いつダウンロードしたかを追跡する
create table receipt_download_log (
  id uuid default gen_random_uuid() primary key,
  purchase_request_id uuid references purchase_requests(id) on delete cascade,
  storage_path text not null,
  downloaded_by uuid references auth.users(id),
  downloaded_at timestamptz default now()
);

alter table receipt_download_log enable row level security;

-- 記録の挿入はreceipt-signed-url Edge Function（service role）のみが行うため、
-- クライアントからのINSERTポリシーは意図的に用意しない
create policy "receipt_download_log_select" on receipt_download_log
  for select using (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    or exists (select 1 from profiles where id = auth.uid() and role_title in ('マネージャー', '社長'))
    or exists (select 1 from purchase_requests pr where pr.id = purchase_request_id and pr.user_id = auth.uid())
  );

create index receipt_download_log_request_idx on receipt_download_log (purchase_request_id, downloaded_at desc);
