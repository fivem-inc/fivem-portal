-- ========================================
-- 安否確認機能 Phase 2：コア（発信・回答・集計）
--
--   データは連絡板（board_*）に相乗りさせない専用テーブル一式にする。
--   理由：board_confirmations は SELECT using(true)＝全員が全員の回答を見られる／
--   INSERT が auth.uid()=user_id 固定＝代行入力が構造的に不可能。
--   安否の要件（一般=自分の回答のみ／代行入力あり／時限的なリーダー閲覧）と
--   根本的に矛盾するため、専用テーブルで満たす。UIは連絡板サイドバーから入る。
--
--   ⚠️ RLS相互再帰の回避：safety_checks⇄recipients⇄responses のような
--   クロステーブル参照は必ず SECURITY DEFINER 関数（is_manager_plus/is_leader/
--   safety_check_is_active等）を経由する。ポリシー内に生のサブクエリで
--   他テーブルを直接書かない（board_message_recipients で実際に無限再帰＝
--   全件消失した事故の再発防止）。
--
--   ⚠️ 通知は通知設定(notification_settings)を一切通さない「強制送信」。
--   ベルは event_key を必ず NULL にする（NOT NULL だと push_dispatch の
--   トリガーがpush_queueに積んでしまい、Edge Functionからの直送と二重になる）。
-- 追加のみ・既存データ無傷。
-- ========================================

-- ⚠️ language sql の関数は作成時に本文中のテーブルの実在確認を行うため、
--   参照するテーブルより後ろで定義する（plpgsqlと違い実行時まで待ってくれない）。
--   このファイルでは「テーブル作成 → 関数作成 → RLS」の順に並べている。

-- 定型メッセージ（管理画面から追加・編集可）
create table if not exists safety_check_templates (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  pattern text not null check (pattern in ('safety3','safety4','attendance2')),
  sort_order int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- 安否確認 本体
create table if not exists safety_checks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  pattern text not null check (pattern in ('safety3','safety4','attendance2')),
  -- 発信時点の選択肢スナップショット [{key,label,color}]。後でプリセットを変えても表示が壊れない
  options jsonb not null,
  is_test boolean not null default false,
  status text not null default 'active' check (status in ('active','closed')),
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  closed_by uuid references auth.users(id),
  closed_at timestamptz,
  cancelled boolean not null default false,   -- 誤発信の取消（closedとは別。取消は全員のバナーを即座に消す）
  cancelled_at timestamptz,
  remind_interval_min int not null default 60 check (remind_interval_min >= 15),
  remind_max int not null default 6 check (remind_max between 0 and 24),
  remind_count int not null default 0,
  next_remind_at timestamptz,
  all_answered_at timestamptz,
  urgent_notified_at timestamptz  -- 「助けが必要」の即時通知を一度でも送ったか（連発防止に使う予定。Phase2では未使用）
);

-- 宛先スナップショット（発信時点で確定。あとでグループ変更しても分母がブレない）
create table if not exists safety_check_recipients (
  check_id uuid not null references safety_checks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  primary key (check_id, user_id)
);

-- 現在の回答（1人1行。本人回答は代行を常に上書き、代行同士・代行→本人は新しい方が勝つ）
create table if not exists safety_check_responses (
  check_id uuid not null references safety_checks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  choice text not null,          -- options内のkey
  comment text,
  is_proxy boolean not null default false,
  proxy_by uuid references auth.users(id),
  answered_at timestamptz not null default now(),
  client_key text,
  primary key (check_id, user_id)
);

-- 回答履歴（append-only。代行→本人上書き等の経緯を保持）
create table if not exists safety_check_response_log (
  id uuid primary key default gen_random_uuid(),
  check_id uuid not null references safety_checks(id) on delete cascade,
  user_id uuid not null,
  choice text not null,
  comment text,
  is_proxy boolean not null,
  proxy_by uuid,
  client_key text,
  created_at timestamptz not null default now()
);

-- 「進行中の本番安否確認が1件でもあるか」（電話番号の時限解錠に使う。テストは含めない）
create or replace function any_active_safety_check() returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from safety_checks where status = 'active' and is_test = false);
$$;

-- 「その安否確認が進行中か」（集計・回答テーブルの時限RLSに使う）
create or replace function safety_check_is_active(p_check_id uuid) returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (select 1 from safety_checks where id = p_check_id and status = 'active');
$$;

-- 「その安否確認の宛先に自分が含まれるか」
create or replace function is_safety_recipient(p_check_id uuid) returns boolean
language sql stable security definer set search_path = public
as $$
  select exists (
    select 1 from safety_check_recipients
     where check_id = p_check_id and user_id = auth.uid()
  );
$$;

create index if not exists safety_checks_status_idx on safety_checks (status, created_at desc);
create index if not exists safety_check_recipients_user_idx on safety_check_recipients (user_id);
create index if not exists safety_check_response_log_check_idx on safety_check_response_log (check_id, created_at);

alter table safety_check_templates enable row level security;
alter table safety_checks enable row level security;
alter table safety_check_recipients enable row level security;
alter table safety_check_responses enable row level security;
alter table safety_check_response_log enable row level security;

-- 定型メッセージ：閲覧は全認証ユーザー、書込はマネージャー以上
drop policy if exists sct_select on safety_check_templates;
create policy sct_select on safety_check_templates for select to authenticated using (true);
drop policy if exists sct_write on safety_check_templates;
create policy sct_write on safety_check_templates for all to authenticated
  using (is_manager_plus()) with check (is_manager_plus());

-- safety_checks：宛先本人 or 発信者 or マネージャー以上 or （リーダーは進行中のみ）
drop policy if exists sc_select on safety_checks;
create policy sc_select on safety_checks for select to authenticated using (
  is_safety_recipient(id) or created_by = auth.uid() or is_manager_plus()
  or (is_leader() and status = 'active')
);
-- INSERT/UPDATEはポリシーを作らない（＝ SECURITY DEFINER RPC 経由のみ）

-- safety_check_recipients：自分の行 or マネージャー以上 or （リーダー×進行中）
drop policy if exists scr_select on safety_check_recipients;
create policy scr_select on safety_check_recipients for select to authenticated using (
  user_id = auth.uid() or is_manager_plus()
  or (is_leader() and safety_check_is_active(check_id))
);

-- safety_check_responses：自分の回答 or マネージャー以上 or （リーダー×進行中）
drop policy if exists scres_select on safety_check_responses;
create policy scres_select on safety_check_responses for select to authenticated using (
  user_id = auth.uid() or is_manager_plus()
  or (is_leader() and safety_check_is_active(check_id))
);

-- safety_check_response_log：本人の行 or マネージャー以上
drop policy if exists scrl_select on safety_check_response_log;
create policy scrl_select on safety_check_response_log for select to authenticated using (
  user_id = auth.uid() or is_manager_plus()
);

-- 電話番号：進行中の本番安否確認がある間だけリーダーにも開放（Phase1で作った本人+manager+のポリシーを差し替え）
drop policy if exists spn_select on staff_phone_numbers;
create policy spn_select on staff_phone_numbers for select to authenticated using (
  user_id = auth.uid() or is_manager_plus() or (is_leader() and any_active_safety_check())
);
