-- ========================================
-- 正社員 残業・勤務時間管理（スプレッドシート「残業申請表」置き換え）
-- 設計: memory/overtime_feature_spec.md（2026-07-20 レビュー2回反映済み）
-- ========================================

-- EXCLUDE制約（時間帯・有効期間の重複禁止）に必要
create extension if not exists btree_gist;

-- 汎用 updated_at トリガー関数
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ========================================
-- 1) 曜日パターン（通常シフト・履歴型）
-- day_kind: mon〜sun ＋ holiday(全員休み日) / work_on_closed(休館日だけど出勤日)
-- break_minutes / labor_minutes は保存時にクライアント（lib/breakCalc.ts）で算出して保存
-- ========================================
create table weekly_shift_patterns (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  day_kind text not null check (day_kind in ('mon','tue','wed','thu','fri','sat','sun','holiday','work_on_closed')),
  start_time time,
  end_time time,
  break_minutes int not null default 0,
  labor_minutes int not null default 0,
  valid_from date not null,
  valid_to date,  -- null = 無期限
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- 開始・終了は両方入れるか両方NULL（NULL = 休み）
  check ((start_time is null) = (end_time is null)),
  -- 同一人×同一day_kindで有効期間の重複を禁止
  exclude using gist (
    user_id with =,
    day_kind with =,
    daterange(valid_from, valid_to, '[]') with &&
  )
);

create index idx_weekly_shift_patterns_user on weekly_shift_patterns(user_id);

create trigger weekly_shift_patterns_updated_at
  before update on weekly_shift_patterns
  for each row execute function set_updated_at();

-- ========================================
-- 2) 会社カレンダー（日付ごとの特別区分。曜日パターンより優先）
-- kind: closed_all = 全員休み（祝扱い） / work_on_closed = 休館日だけど出勤日（出扱い）
-- 有給奨励日は既存 paid_leave_encouragement_days を参照するためここには持たない
-- ========================================
create table company_calendar (
  date date primary key,
  kind text not null check (kind in ('closed_all','work_on_closed')),
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger company_calendar_updated_at
  before update on company_calendar
  for each row execute function set_updated_at();

-- ========================================
-- 3) 残業・時間調整申請（中心テーブル）
-- 事前申請と実績報告は同一行のstatus遷移で管理:
--   requested(事前申請中) → request_confirmed(事前受理) → reported(実績確認待ち) → confirmed(確認済み)
--   ＋ returned(差し戻し) / cancelled(取消)
--   事後報告単体は is_post_hoc=true で reported から開始
-- entry_type='leave_auto' は時間外調整休の受理による自動マイナス計上行
--   （トリガーが作成。status='confirmed'固定・source_leave_request_id必須）
-- normal_shift: 申請時点の通常シフトのスナップショット（後からパターンを変えても過去の集計が変わらない）
-- 時間量はすべて符号付きint分・1分単位
-- ========================================
create table overtime_reports (
  id uuid primary key default gen_random_uuid(),

  applicant_id uuid not null references auth.users(id) on delete cascade,
  submitted_by uuid not null references auth.users(id),
  work_date date not null,
  pay_period_start date not null,

  entry_type text not null default 'manual' check (entry_type in ('manual','leave_auto')),
  is_post_hoc boolean not null default false,
  status text not null default 'requested'
    check (status in ('requested','request_confirmed','reported','confirmed','returned','cancelled')),

  normal_shift jsonb,
  break_minutes int,
  break_manual boolean not null default false,
  labor_minutes int,
  diff_minutes int,
  legal_warning boolean not null default false,

  reason text,
  location text,  -- 校（attendance_exceptions/GCal周知の再利用に使用）
  reviewer_id uuid references auth.users(id),
  confirmed_by uuid references auth.users(id),
  confirmed_at timestamptz,
  return_comment text,

  source_leave_request_id uuid references leave_requests(id) on delete cascade,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- 自動計上行は confirmed 固定＋元休暇申請必須
  check (
    entry_type <> 'leave_auto'
    or (status = 'confirmed' and source_leave_request_id is not null)
  )
);

-- 同一人×同一日は手動行1件のみ（取消行は再申請を妨げない）
create unique index uq_overtime_manual_per_day
  on overtime_reports(applicant_id, work_date)
  where status <> 'cancelled' and entry_type = 'manual';

-- 自動計上行は同一休暇申請×同一日で1件
create unique index uq_overtime_leave_auto
  on overtime_reports(applicant_id, work_date, source_leave_request_id)
  where entry_type = 'leave_auto';

create index idx_overtime_reports_applicant on overtime_reports(applicant_id);
create index idx_overtime_reports_pay_period on overtime_reports(pay_period_start);
create index idx_overtime_reports_reviewer on overtime_reports(reviewer_id);
create index idx_overtime_reports_status on overtime_reports(status);
create index idx_overtime_reports_source_leave on overtime_reports(source_leave_request_id);

create trigger overtime_reports_updated_at
  before update on overtime_reports
  for each row execute function set_updated_at();

-- 修正履歴（shift_report_history と同方式）
create table overtime_report_history (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references overtime_reports(id) on delete cascade,
  changed_by uuid not null references auth.users(id),
  changed_at timestamptz not null default now(),
  change_summary text,
  snapshot jsonb not null
);

create index idx_overtime_report_history_report on overtime_report_history(report_id);

-- ========================================
-- 4) 勤務時間帯（最大3枠。外出・戻りの分割勤務対応）
-- phase: planned = 事前申請の予定 / actual = 実績
-- start_min/end_min: その日の0:00からの分。深夜跨ぎは翌日を+1440分で表現（上限 翌日24:00=2880）
-- ========================================
create table overtime_report_segments (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references overtime_reports(id) on delete cascade,
  phase text not null check (phase in ('planned','actual')),
  seg_no int not null check (seg_no between 1 and 3),
  start_min int not null check (start_min >= 0 and start_min < 1440),
  end_min int not null check (end_min <= 2880),
  check (start_min < end_min),
  unique (report_id, phase, seg_no),
  -- 同一申請×同一phase内で時間帯の重複を禁止
  exclude using gist (
    report_id with =,
    phase with =,
    int4range(start_min, end_min) with &&
  )
);

create index idx_overtime_report_segments_report on overtime_report_segments(report_id);

-- ========================================
-- 5) 設定（1行固定）
-- threshold_minutes: 超過FYIバナーのしきい値（分。初期600=10時間）
-- banner_group_names: リーダーの「自チーム」判定に使う部門系グループ名のホワイトリスト
-- ========================================
create table overtime_settings (
  id int primary key default 1 check (id = 1),
  threshold_minutes int not null default 600,
  banner_group_names jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

insert into overtime_settings (id) values (1);

create trigger overtime_settings_updated_at
  before update on overtime_settings
  for each row execute function set_updated_at();

-- 超過バナーを閉じた状態（期ごと・見る人×対象者ごと）
create table overtime_banner_dismissals (
  user_id uuid not null references auth.users(id) on delete cascade,
  target_user_id uuid not null references auth.users(id) on delete cascade,
  pay_period_start date not null,
  dismissed_at timestamptz not null default now(),
  primary key (user_id, target_user_id, pay_period_start)
);

-- Excel取り込み用の名前エイリアス（旧姓・通称・表記ゆれをアプリのスタッフに紐付ける）
-- excel_name は正規化済み（空白除去）のシフト表表記名
create table overtime_name_aliases (
  id uuid primary key default gen_random_uuid(),
  excel_name text not null unique,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index idx_overtime_name_aliases_user on overtime_name_aliases(user_id);

-- ========================================
-- 6) leave_requests に調整休サブ種別列を追加
-- 現在は reason 文字列への埋め込みのみ（「振替休日（…）」「時間外調整休」）
-- ========================================
alter table leave_requests
  add column if not exists chosei_sub_type text
  check (chosei_sub_type in ('furikae','zangyou'));

-- 既存データのバックフィル（reasonの埋め込み文言から判定）
update leave_requests
set chosei_sub_type = 'zangyou'
where leave_type = '調整休' and chosei_sub_type is null and reason like '%時間外調整休%';

update leave_requests
set chosei_sub_type = 'furikae'
where leave_type = '調整休' and chosei_sub_type is null and reason like '%振替休日%';

-- ========================================
-- 7) 権限判定関数（役職名ハードコード禁止・feature_permissions参照に一元化）
-- 画面の出し分けとRLSが同じ設定を見る。管理者JWTはバイパス。
-- role_id 未設定の既存プロフィールは role_title 経由でフォールバック解決。
-- ========================================
create or replace function has_feature_permission(p_feature text)
returns boolean
language sql stable security definer set search_path = public as $$
  select (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    or exists (
      select 1
      from profiles p
      join roles r
        on r.id = p.role_id
        or (p.role_id is null and r.name = p.role_title)
      join feature_permissions fp
        on fp.role_id = r.id and fp.feature_key = p_feature
      where p.id = auth.uid() and fp.enabled
    );
$$;

-- ========================================
-- 8) 時間外調整休 受理連動トリガー
-- 受理経路が複数あるため（通常受理・自己受理・管理画面の強制進行/種別変更/巻き戻し）
-- RPCではなく leave_requests のトリガーで同期する（第2回レビュー指摘1）
--   approved へ遷移 → 日ごとにマイナス行を自動作成
--   approved から離脱 → 自動計上行を削除
--   物理DELETE → FK on delete cascade で自動削除
-- ========================================
create or replace function sync_overtime_from_leave()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  d date;
  v_kind text;
  v_day_kind text;
  v_pattern weekly_shift_patterns%rowtype;
begin
  -- approved から離脱：自動計上行を削除
  if old.status = 'approved' and new.status is distinct from 'approved' then
    delete from overtime_reports
    where source_leave_request_id = new.id and entry_type = 'leave_auto';
  end if;

  -- approved へ遷移した時間外調整休：日ごとにマイナス行を作成
  if new.status = 'approved' and old.status is distinct from 'approved'
     and new.leave_type = '調整休' and new.chosei_sub_type = 'zangyou' then

    -- 冪等性のため既存の自動計上行を消してから作り直す
    delete from overtime_reports
    where source_leave_request_id = new.id and entry_type = 'leave_auto';

    for d in
      select (jsonb_array_elements_text(new.leave_dates::jsonb))::date
    loop
      -- 会社カレンダー優先で day_kind を解決
      select kind into v_kind from company_calendar where date = d;
      if v_kind = 'closed_all' then
        v_day_kind := 'holiday';
      elsif v_kind = 'work_on_closed' then
        v_day_kind := 'work_on_closed';
      else
        v_day_kind := (array['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from d)::int + 1];
      end if;

      select * into v_pattern from weekly_shift_patterns
      where user_id = new.user_id
        and day_kind = v_day_kind
        and valid_from <= d
        and (valid_to is null or valid_to >= d)
      limit 1;

      -- その日に通常シフトがある場合のみマイナス計上（休みの日の調整休は0のため対象外）
      if v_pattern.id is not null and v_pattern.labor_minutes > 0 then
        insert into overtime_reports (
          applicant_id, submitted_by, work_date, pay_period_start,
          entry_type, status,
          normal_shift, break_minutes, break_manual, labor_minutes, diff_minutes,
          reason, confirmed_by, confirmed_at, source_leave_request_id
        ) values (
          new.user_id, new.user_id, d, calc_pay_period_start(d),
          'leave_auto', 'confirmed',
          jsonb_build_object(
            'day_kind', v_day_kind,
            'calendar_kind', v_kind,
            'start_time', v_pattern.start_time,
            'end_time', v_pattern.end_time,
            'break_minutes', v_pattern.break_minutes,
            'labor_minutes', v_pattern.labor_minutes
          ),
          0, false, 0, -v_pattern.labor_minutes,
          '時間外調整休（休暇申請より自動計上）',
          new.approver_id, now(), new.id
        );
      end if;
    end loop;
  end if;

  return new;
end;
$$;

create trigger leave_requests_sync_overtime
  after update on leave_requests
  for each row
  when (old.status is distinct from new.status)
  execute function sync_overtime_from_leave();

-- ========================================
-- 9) RLS
-- ========================================
alter table weekly_shift_patterns enable row level security;
alter table company_calendar enable row level security;
alter table overtime_reports enable row level security;
alter table overtime_report_history enable row level security;
alter table overtime_report_segments enable row level security;
alter table overtime_settings enable row level security;
alter table overtime_banner_dismissals enable row level security;
alter table overtime_name_aliases enable row level security;

-- 曜日パターン：本人は自分の分を参照可（UX指摘14）。集計閲覧者は全件参照可。変更は管理者のみ
create policy "patterns_select_own" on weekly_shift_patterns
  for select using (user_id = auth.uid());

create policy "patterns_select_summary" on weekly_shift_patterns
  for select using (has_feature_permission('overtime_summary'));

create policy "patterns_admin_all" on weekly_shift_patterns
  for all using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- 会社カレンダー：全認証ユーザー参照可。変更は管理者のみ
create policy "calendar_select_authenticated" on company_calendar
  for select to authenticated using (true);

create policy "calendar_admin_all" on company_calendar
  for all using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- 申請本体：本人参照・作成・編集可。集計閲覧者と担当確認者は参照可。確認者は受理更新可
create policy "overtime_select_own" on overtime_reports
  for select using (applicant_id = auth.uid());

create policy "overtime_select_reviewer" on overtime_reports
  for select using (reviewer_id = auth.uid());

create policy "overtime_select_summary" on overtime_reports
  for select using (has_feature_permission('overtime_summary'));

-- 作成は本人のみ・手動行のみ（自動計上行はトリガー(SECURITY DEFINER)が作成）
create policy "overtime_insert_own" on overtime_reports
  for insert with check (
    submitted_by = auth.uid()
    and applicant_id = auth.uid()
    and entry_type = 'manual'
  );

-- 本人は確認済みになる前の手動行を編集可（実績報告・取消・差し戻し後の再提出）
create policy "overtime_update_own" on overtime_reports
  for update using (
    applicant_id = auth.uid()
    and entry_type = 'manual'
    and status in ('requested','request_confirmed','reported','returned')
  );

-- 担当確認者は受理・差し戻しの更新可
create policy "overtime_update_reviewer" on overtime_reports
  for update using (
    reviewer_id = auth.uid()
    and entry_type = 'manual'
    and has_feature_permission('overtime')
  );

create policy "overtime_admin_all" on overtime_reports
  for all using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- 履歴：本人・担当確認者・集計閲覧者が参照可。追加は本人記名のみ
create policy "overtime_history_select" on overtime_report_history
  for select using (
    changed_by = auth.uid()
    or has_feature_permission('overtime_summary')
    or exists (
      select 1 from overtime_reports r
      where r.id = report_id
        and (r.applicant_id = auth.uid() or r.reviewer_id = auth.uid())
    )
  );

create policy "overtime_history_insert" on overtime_report_history
  for insert with check (changed_by = auth.uid());

-- 時間帯：親申請の参照権限に従う。編集は本人（親が編集可能な状態のとき）
create policy "segments_select" on overtime_report_segments
  for select using (
    exists (
      select 1 from overtime_reports r
      where r.id = report_id
        and (
          r.applicant_id = auth.uid()
          or r.reviewer_id = auth.uid()
          or has_feature_permission('overtime_summary')
        )
    )
  );

create policy "segments_write_own" on overtime_report_segments
  for all using (
    exists (
      select 1 from overtime_reports r
      where r.id = report_id
        and r.applicant_id = auth.uid()
        and r.status in ('requested','request_confirmed','reported','returned')
    )
  )
  with check (
    exists (
      select 1 from overtime_reports r
      where r.id = report_id
        and r.applicant_id = auth.uid()
        and r.status in ('requested','request_confirmed','reported','returned')
    )
  );

create policy "segments_admin_all" on overtime_report_segments
  for all using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- 設定：全認証ユーザー参照可（バナーしきい値の表示に必要）。変更は管理者のみ
create policy "overtime_settings_select" on overtime_settings
  for select to authenticated using (true);

create policy "overtime_settings_admin_all" on overtime_settings
  for all using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- バナー閉じ状態：自分の行のみ
create policy "banner_dismissals_own" on overtime_banner_dismissals
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- 名前エイリアス：管理者のみ（Excel取り込みは管理画面専用）
create policy "name_aliases_admin_all" on overtime_name_aliases
  for all using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- ========================================
-- 10) feature_permissions seed
-- overtime         : ページ利用（正社員系。パートは既存の勤務変更報告を利用）
-- overtime_summary : 集計・全員分の超過バナー閲覧（リーダー以上。フロア責任者は含めない＝序列ルール）
-- 行が無いロール（後からUIで追加されたロール）は has_feature_permission が false を返す
-- ========================================
do $$
declare
  r record;
begin
  for r in select id, name from roles loop
    insert into feature_permissions (role_id, feature_key, enabled)
    values (
      r.id, 'overtime',
      r.name in ('一般','リーダー','マネージャー','フロア責任者','社長','管理者')
    )
    on conflict (role_id, feature_key) do nothing;

    insert into feature_permissions (role_id, feature_key, enabled)
    values (
      r.id, 'overtime_summary',
      r.name in ('リーダー','マネージャー','社長','管理者')
    )
    on conflict (role_id, feature_key) do nothing;
  end loop;
end $$;

-- ========================================
-- 11) 先行公開フラグ seed（フロントデプロイ前に必須：キー未設定=全公開のため）
-- 全公開: false / リーダー以上: false / 社長のみ: true（テスト用の新区分）
-- ========================================
do $$
begin
  update app_settings
  set value = coalesce(value, '{}'::jsonb) || '{"overtime": false}'::jsonb
  where key = 'feature_published';
  if not found then
    insert into app_settings (key, value) values ('feature_published', '{"overtime": false}'::jsonb);
  end if;

  update app_settings
  set value = coalesce(value, '{}'::jsonb) || '{"overtime": false}'::jsonb
  where key = 'feature_published_leader';
  if not found then
    insert into app_settings (key, value) values ('feature_published_leader', '{"overtime": false}'::jsonb);
  end if;

  update app_settings
  set value = coalesce(value, '{}'::jsonb) || '{"overtime": true}'::jsonb
  where key = 'feature_published_president';
  if not found then
    insert into app_settings (key, value) values ('feature_published_president', '{"overtime": true}'::jsonb);
  end if;
end $$;
