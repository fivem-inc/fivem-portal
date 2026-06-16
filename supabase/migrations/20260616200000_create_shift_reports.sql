-- シフト実績申請テーブル
create table shift_reports (
  id uuid primary key default gen_random_uuid(),

  -- 申請者・操作者
  applicant_id uuid not null references auth.users(id) on delete cascade,
  submitted_by uuid not null references auth.users(id),

  -- 申請内容
  work_date date not null,
  pay_period_start date not null,  -- 給与締め開始日（16日）
  application_type text not null check (application_type in ('overtime', 'early_leave', 'absence')),
  reason text not null,

  -- 通常シフト
  original_location text,
  original_start time,
  original_end time,

  -- 実務シフト（欠勤の場合はNULL）
  actual_location text,
  actual_start time,
  actual_end time,

  -- 計算値（Edge Functionで算出して保存）
  break_minutes int,
  labor_minutes int,

  -- 確認フロー
  reviewer_id uuid references auth.users(id),
  status text not null default 'pending' check (status in ('pending', 'confirmed', 'resubmitted')),
  confirmed_by uuid references auth.users(id),
  confirmed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- 同一スタッフ×同一日は1件のみ
  unique (applicant_id, work_date)
);

-- 修正履歴テーブル
create table shift_report_history (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references shift_reports(id) on delete cascade,
  changed_by uuid not null references auth.users(id),
  changed_at timestamptz not null default now(),
  change_summary text,        -- 「〇〇→▼▼に変更 理由：〇〇」
  snapshot jsonb not null     -- 変更前のスナップショット
);

-- インデックス
create index idx_shift_reports_applicant on shift_reports(applicant_id);
create index idx_shift_reports_pay_period on shift_reports(pay_period_start);
create index idx_shift_reports_reviewer on shift_reports(reviewer_id);
create index idx_shift_reports_status on shift_reports(status);
create index idx_shift_report_history_report on shift_report_history(report_id);

-- updated_at 自動更新
create or replace function update_shift_reports_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger shift_reports_updated_at
  before update on shift_reports
  for each row execute function update_shift_reports_updated_at();

-- RLS
alter table shift_reports enable row level security;
alter table shift_report_history enable row level security;

-- 本人は自分の申請を参照・作成・更新できる
create policy "applicant_select" on shift_reports
  for select using (applicant_id = auth.uid());

create policy "applicant_insert" on shift_reports
  for insert with check (submitted_by = auth.uid());

create policy "applicant_update_own_pending" on shift_reports
  for update using (
    applicant_id = auth.uid()
    and status in ('pending', 'resubmitted')
  );

-- リーダー・マネージャー・フロア責任者・管理者は全件参照
create policy "approver_select" on shift_reports
  for select using (
    (auth.jwt() ->> 'role') = 'admin'
    or exists (
      select 1 from profiles
      where id = auth.uid()
        and role_title in ('リーダー', 'マネージャー', 'フロア責任者', '社長', '管理者')
    )
  );

-- 確認者本人のみ confirmed に更新できる
create policy "reviewer_confirm" on shift_reports
  for update using (
    reviewer_id = auth.uid()
    and (
      (auth.jwt() ->> 'role') = 'admin'
      or exists (
        select 1 from profiles
        where id = auth.uid()
          and role_title in ('リーダー', 'マネージャー', 'フロア責任者', '社長', '管理者')
      )
    )
  );

-- 代行申請：リーダー以上は他スタッフの申請をINSERT可
create policy "proxy_insert" on shift_reports
  for insert with check (
    submitted_by = auth.uid()
    and (
      (auth.jwt() ->> 'role') = 'admin'
      or exists (
        select 1 from profiles
        where id = auth.uid()
          and role_title in ('リーダー', 'マネージャー', 'フロア責任者', '社長', '管理者')
      )
    )
  );

-- 履歴は本人・承認者が参照可
create policy "history_select" on shift_report_history
  for select using (
    changed_by = auth.uid()
    or exists (
      select 1 from shift_reports sr
      where sr.id = report_id
        and sr.applicant_id = auth.uid()
    )
    or (auth.jwt() ->> 'role') = 'admin'
    or exists (
      select 1 from profiles
      where id = auth.uid()
        and role_title in ('リーダー', 'マネージャー', 'フロア責任者', '社長', '管理者')
    )
  );

create policy "history_insert" on shift_report_history
  for insert with check (changed_by = auth.uid());

-- master_options にフロア責任者を追加
insert into master_options (category, value, sort_order)
values ('role_title', 'フロア責任者', 35)
on conflict do nothing;

-- pay_period_start を自動計算するヘルパー関数
-- 例：6/1〜6/15 → 5/16、6/16〜6/30 → 6/16
create or replace function calc_pay_period_start(d date)
returns date language sql immutable as $$
  select case
    when extract(day from d) >= 16
      then date_trunc('month', d)::date + 15
    else (date_trunc('month', d) - interval '1 month')::date + 15
  end;
$$;
