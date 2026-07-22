-- 残業調整 提案機能 第1段：提案テーブル＋RLS＋回答排他RPC
-- 仕様: scratchpad/overtime-adjust-proposal-spec.md / plan.md（2体レビュー反映）
-- 第1段は「時間調整（遅出/早退）」のみ運用。kind の chosei_off は第2段用に許可だけしておく。
-- 権限は既存 overtime_role_rank / overtime_role_rank_target / has_feature_permission('overtime_summary') を流用。

-- 1) 提案（1件＝提案者→相手1人・ある支給期間の残業相殺の提案）
create table if not exists overtime_adjustment_proposals (
  id uuid primary key default gen_random_uuid(),
  proposer_id  uuid not null references auth.users(id) on delete cascade,
  recipient_id uuid not null references auth.users(id) on delete cascade,
  pay_period_start date not null,
  overtime_snapshot_minutes int,          -- 提案時点の残高（参考表示用）
  remarks text,                           -- 備考（提案レコードのみ保持・申請notesには継承しない）
  response_due_date date,                 -- お返事の目安（やわらかい・自動失効なし）
  status text not null default 'open' check (status in ('open','responded','withdrawn')),
  recipient_note text,                    -- 回答時の理由（見送り含む）
  responded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_oap_recipient on overtime_adjustment_proposals(recipient_id);
create index if not exists idx_oap_proposer  on overtime_adjustment_proposals(proposer_id);

-- 2) 提案の候補（遅出/早退/調整休。第1段は late_start/early_end のみ使用）
create table if not exists overtime_adjustment_proposal_options (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references overtime_adjustment_proposals(id) on delete cascade,
  kind text not null check (kind in ('late_start','early_end','chosei_off')),
  work_date date not null,
  adjust_time time,                       -- 遅出＝出勤時刻／早退＝退勤時刻
  location text,
  offset_minutes int not null default 0,  -- 提案者指定時刻から算出した相殺見込み（分）
  note text,
  selection text not null default 'pending' check (selection in ('pending','accepted','declined','custom')),
  custom_date date,                       -- カスタム時の実値
  custom_time time,
  result_type text check (result_type in ('overtime_report','leave_request')),
  result_id uuid,                         -- 受諾で作られたレコードのid（把握・冪等スキップ用）
  created_at timestamptz not null default now()
);
create index if not exists idx_oapo_proposal on overtime_adjustment_proposal_options(proposal_id);

-- updated_at トリガ（既存の共通トリガ関数 set_updated_at があれば流用。無ければ即席）
create or replace function set_oap_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end; $$;
drop trigger if exists trg_oap_updated_at on overtime_adjustment_proposals;
create trigger trg_oap_updated_at before update on overtime_adjustment_proposals
  for each row execute function set_oap_updated_at();

-- 3) RLS
alter table overtime_adjustment_proposals enable row level security;
alter table overtime_adjustment_proposal_options enable row level security;

-- 閲覧できる提案かどうかの共通条件（本人=相手/提案者、監督=summary権限＋rank、管理者）
-- ※ recipient本人が自分宛を見られるよう roster RPC は使わず rank 式を直接使う（M2）
create or replace function oap_can_view(p_recipient uuid, p_proposer uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select
    p_recipient = auth.uid()
    or p_proposer = auth.uid()
    or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    or (
      has_feature_permission('overtime_summary')
      and overtime_role_rank_target(p_recipient) >= (select overtime_role_rank(auth.uid()))
    );
$$;
revoke execute on function oap_can_view(uuid, uuid) from public;
grant  execute on function oap_can_view(uuid, uuid) to authenticated;

-- 提案者になれる（相手を監督できる）か
create or replace function oap_can_propose_to(p_recipient uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    or (
      has_feature_permission('overtime_summary')
      and overtime_role_rank_target(p_recipient) >= (select overtime_role_rank(auth.uid()))
    );
$$;
revoke execute on function oap_can_propose_to(uuid) from public;
grant  execute on function oap_can_propose_to(uuid) to authenticated;

-- proposals
drop policy if exists oap_select on overtime_adjustment_proposals;
create policy oap_select on overtime_adjustment_proposals
  for select using (oap_can_view(recipient_id, proposer_id));

drop policy if exists oap_insert on overtime_adjustment_proposals;
create policy oap_insert on overtime_adjustment_proposals
  for insert with check (proposer_id = auth.uid() and oap_can_propose_to(recipient_id));

-- 回答は relrecipient（open時のみ）、取り下げは提案者、管理者は保守用
drop policy if exists oap_update on overtime_adjustment_proposals;
create policy oap_update on overtime_adjustment_proposals
  for update using (
    recipient_id = auth.uid() or proposer_id = auth.uid()
    or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );

-- options（親提案の可視性に従う）
drop policy if exists oapo_select on overtime_adjustment_proposal_options;
create policy oapo_select on overtime_adjustment_proposal_options
  for select using (exists (
    select 1 from overtime_adjustment_proposals p
    where p.id = proposal_id and oap_can_view(p.recipient_id, p.proposer_id)
  ));

drop policy if exists oapo_insert on overtime_adjustment_proposal_options;
create policy oapo_insert on overtime_adjustment_proposal_options
  for insert with check (exists (
    select 1 from overtime_adjustment_proposals p
    where p.id = proposal_id and p.proposer_id = auth.uid()
  ));

-- 回答（selection/custom/result_id 書き戻し）は相手、取り下げ時の掃除は提案者
drop policy if exists oapo_update on overtime_adjustment_proposal_options;
create policy oapo_update on overtime_adjustment_proposal_options
  for update using (exists (
    select 1 from overtime_adjustment_proposals p
    where p.id = proposal_id and (p.recipient_id = auth.uid() or p.proposer_id = auth.uid()
      or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  ));

-- 4) 回答の排他（R4：二重回答防止）。open→responded を1回だけ成立させ、
--    候補の selection/custom を反映する。実レコード(overtime_reports)作成は
--    受け手セッションのクライアント側で既存計算を再利用して行う（result_id を後で書き戻す）。
create or replace function respond_overtime_adjustment_proposal(
  p_proposal_id uuid,
  p_note text,
  p_options jsonb           -- [{option_id, selection, custom_date, custom_time}, ...]
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_claimed int;
begin
  update overtime_adjustment_proposals
    set status = 'responded', recipient_note = p_note, responded_at = now()
    where id = p_proposal_id and recipient_id = auth.uid() and status = 'open';
  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    return false;  -- 既に回答済み or 権限なし → 呼び出し側で「回答済みです」を表示
  end if;

  update overtime_adjustment_proposal_options o set
    selection   = coalesce(nullif(e->>'selection',''), o.selection),
    custom_date = nullif(e->>'custom_date','')::date,
    custom_time = nullif(e->>'custom_time','')::time
  from jsonb_array_elements(coalesce(p_options, '[]'::jsonb)) e
  where o.id = (e->>'option_id')::uuid and o.proposal_id = p_proposal_id;

  return true;
end; $$;
revoke execute on function respond_overtime_adjustment_proposal(uuid, text, jsonb) from public;
grant  execute on function respond_overtime_adjustment_proposal(uuid, text, jsonb) to authenticated;

-- 5) 通知設定（プッシュのON/OFF用）。ベルは insertNotification 直挿しで出すため site 行は必須でないが、
--    プッシュは push-dispatch が notification_settings(channel='push') の enabled を見るため行が要る。
insert into notification_settings (event_key, channel, enabled, recipient, subject, template) values
  ('overtime_proposal:received',  'push', true, null, null, null),
  ('overtime_proposal:responded', 'push', true, null, null, null)
on conflict (event_key, channel) do nothing;
