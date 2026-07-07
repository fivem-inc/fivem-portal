-- 管理画面での購入申請/精算記録の修正履歴を記録するテーブル
create table purchase_request_edit_log (
  id uuid default gen_random_uuid() primary key,
  purchase_request_id uuid not null references purchase_requests(id) on delete cascade,
  edited_by uuid references auth.users(id),
  edited_at timestamptz default now(),
  changes jsonb not null -- { フィールド名: { old: ..., new: ... } } の形式
);

alter table purchase_request_edit_log enable row level security;

create policy "purchase_request_edit_log_admin_select" on purchase_request_edit_log
  for select using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

create policy "purchase_request_edit_log_admin_insert" on purchase_request_edit_log
  for insert with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

create index purchase_request_edit_log_request_idx on purchase_request_edit_log (purchase_request_id, edited_at desc);
