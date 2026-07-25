-- 締め後申請の許可を「給与期間まるごと」→「対象日1日ごと」に変更し、
-- 本人から経理へ「許可してください」と依頼できる機能を追加する。
-- 既存の overtime_submission_grants は本番未使用（0件）確認済みのため作り直す。

-- ========================================
-- 1) overtime_submission_grants を対象日単位に作り直す
-- ========================================
drop table if exists overtime_submission_grants cascade;

create table overtime_submission_grants (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  work_date   date not null,
  granted_by  uuid not null references auth.users(id),
  note        text,
  revoked_at  timestamptz,
  revoked_by  uuid references auth.users(id),
  created_at  timestamptz not null default now()
);

-- PostgREST の upsert(onConflict) は部分ユニークインデックスをターゲットにできないため、通常のユニーク制約にする
create unique index uq_overtime_grant_user_workdate on overtime_submission_grants(user_id, work_date);
create index idx_overtime_grants_user on overtime_submission_grants(user_id);

alter table overtime_submission_grants enable row level security;

create policy "overtime_grants_select_own" on overtime_submission_grants
  for select using (
    user_id = auth.uid()
    or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );

create policy "overtime_grants_admin_all" on overtime_submission_grants
  for all using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- ========================================
-- 2) 締めロックの許可窓判定を「対象日一致」に変更（従来は給与期間一致）
-- ========================================
create or replace function enforce_overtime_submission_window()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role      text;
  v_app_role  text;
  v_pps       date;
  v_cutoff    date;
  v_today     date := (now() at time zone 'Asia/Tokyo')::date;
  v_grant     int;
begin
  if new.entry_type <> 'manual' then
    return new;
  end if;

  v_role     := coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '');
  v_app_role := coalesce(current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'role', '');
  if v_role = 'service_role' or v_app_role = 'admin' then
    return new;
  end if;

  if extract(day from new.work_date) >= 16 then
    v_pps := date_trunc('month', new.work_date)::date + 15;
  else
    v_pps := (date_trunc('month', new.work_date) - interval '1 month')::date + 15;
  end if;
  new.pay_period_start := v_pps;

  v_cutoff := (date_trunc('month', v_pps + interval '1 month'))::date + 16;

  if v_today > v_cutoff then
    -- 許可窓は「対象日そのもの」に対して付与されているかで判定（従来は給与期間まるごと）
    select count(*) into v_grant
    from overtime_submission_grants g
    where g.user_id = new.applicant_id
      and g.work_date = new.work_date
      and g.revoked_at is null;

    if v_grant = 0 then
      raise exception 'OVERTIME_CLOSED: この対象日の給与期間は締め切り（%）を過ぎています。経理に申請の許可を依頼してください。', to_char(v_cutoff, 'YYYY/MM/DD')
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

-- ========================================
-- 3) 給与データ確定日（依頼できる期限）を計算する関数
--    支給日（支給月25日）の前日を基準に、土日・会社カレンダーの休館日(closed_all)なら前営業日まで遡る
-- ========================================
create or replace function overtime_grant_deadline(p_pps date)
returns date
language plpgsql
stable
set search_path = public
as $$
declare
  v_payout date;
  v_d date;
begin
  v_payout := (date_trunc('month', p_pps + interval '1 month'))::date + 24; -- 翌月1日+24=25日
  v_d := v_payout - 1;
  loop
    if extract(dow from v_d) not in (0, 6)
       and not exists (select 1 from company_calendar where date = v_d and kind = 'closed_all') then
      exit;
    end if;
    v_d := v_d - 1;
  end loop;
  return v_d;
end;
$$;

grant execute on function overtime_grant_deadline(date) to authenticated;

-- ========================================
-- 4) 依頼テーブル（本人×複数対象日で1依頼、状態を open/resolved/declined/withdrawn で管理）
-- ========================================
create table overtime_submission_grant_requests (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  work_dates    date[] not null,
  status        text not null default 'open' check (status in ('open','resolved','declined','withdrawn')),
  note          text,
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz,
  resolved_by   uuid references auth.users(id),
  resolve_note  text,
  check (array_length(work_dates, 1) > 0)
);

create index idx_overtime_grant_requests_user on overtime_submission_grant_requests(user_id);
create index idx_overtime_grant_requests_status on overtime_submission_grant_requests(status);

alter table overtime_submission_grant_requests enable row level security;

create policy "overtime_grant_requests_select" on overtime_submission_grant_requests
  for select using (
    user_id = auth.uid()
    or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );

create policy "overtime_grant_requests_insert_own" on overtime_submission_grant_requests
  for insert with check (user_id = auth.uid());

create policy "overtime_grant_requests_update" on overtime_submission_grant_requests
  for update using (
    user_id = auth.uid()
    or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  ) with check (
    user_id = auth.uid()
    or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );

-- ========================================
-- 5) 依頼作成時のサーバー側検証（クライアントのチェックだけに頼らない）
--    ・自分の分のみ作成できる
--    ・対象日は「締め切り(17日)を過ぎている」かつ「給与データ確定日を過ぎていない」の間だけ
--    ・既に許可済みの日、他のopenな依頼と重複する日は不可
-- ========================================
create or replace function enforce_grant_request_validity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  d          date;
  v_pps      date;
  v_cutoff   date;
  v_deadline date;
  v_today    date := (now() at time zone 'Asia/Tokyo')::date;
begin
  if new.user_id <> auth.uid() and coalesce(current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'role', '') <> 'admin' then
    raise exception 'FORBIDDEN: 自分の依頼のみ作成できます';
  end if;

  foreach d in array new.work_dates loop
    if extract(day from d) >= 16 then
      v_pps := date_trunc('month', d)::date + 15;
    else
      v_pps := (date_trunc('month', d) - interval '1 month')::date + 15;
    end if;
    v_cutoff   := (date_trunc('month', v_pps + interval '1 month'))::date + 16;
    v_deadline := overtime_grant_deadline(v_pps);

    if v_today <= v_cutoff then
      raise exception 'NOT_LOCKED: %はまだ締め切り前のため依頼できません', to_char(d, 'YYYY/MM/DD')
        using errcode = 'check_violation';
    end if;
    if v_today > v_deadline then
      raise exception 'PAYOUT_PASSED: %の給与期間は給与データ確定日（%）を過ぎているため依頼できません。管理者にご相談ください', to_char(d, 'YYYY/MM/DD'), to_char(v_deadline, 'YYYY/MM/DD')
        using errcode = 'check_violation';
    end if;

    if exists (
      select 1 from overtime_submission_grants g
      where g.user_id = new.user_id and g.work_date = d and g.revoked_at is null
    ) then
      raise exception 'ALREADY_GRANTED: %は既に許可されています', to_char(d, 'YYYY/MM/DD')
        using errcode = 'check_violation';
    end if;

    if exists (
      select 1 from overtime_submission_grant_requests r
      where r.user_id = new.user_id and r.status = 'open' and d = any(r.work_dates)
    ) then
      raise exception 'DUPLICATE_REQUEST: %は既に依頼中です', to_char(d, 'YYYY/MM/DD')
        using errcode = 'check_violation';
    end if;
  end loop;

  return new;
end;
$$;

drop trigger if exists trg_enforce_grant_request_validity on overtime_submission_grant_requests;
create trigger trg_enforce_grant_request_validity
  before insert on overtime_submission_grant_requests
  for each row execute function enforce_grant_request_validity();

-- ========================================
-- 6) 改ざん防止：本人は open→withdrawn の遷移のみ可能（他の値・他の列は不変）。管理者(admin)は制限なし
-- ========================================
create or replace function protect_grant_request_fields()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean;
begin
  v_is_admin := (coalesce(current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'role', '') = 'admin');
  if v_is_admin then
    return new;
  end if;

  if old.status <> 'open' then
    raise exception 'IMMUTABLE: 対応済みの依頼は変更できません';
  end if;
  if new.status <> 'withdrawn' then
    raise exception 'FORBIDDEN: この操作はできません';
  end if;
  if new.user_id <> old.user_id or new.work_dates <> old.work_dates or new.note is distinct from old.note then
    raise exception 'FORBIDDEN: 対象日や依頼内容は変更できません';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_protect_grant_request_fields on overtime_submission_grant_requests;
create trigger trg_protect_grant_request_fields
  before update on overtime_submission_grant_requests
  for each row execute function protect_grant_request_fields();

-- ========================================
-- 7) 許可／見送りを1トランザクションで行うRPC（経理=app_metadata admin のみ実行可）
--    楽観ロック：status='open' の間だけ処理し、更新0件なら競合として例外
-- ========================================
create or replace function resolve_overtime_grant_request(
  p_request_id  uuid,
  p_approve     boolean,
  p_resolve_note text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req      record;
  v_uid      uuid := auth.uid();
  v_is_admin boolean;
  d          date;
  v_updated  int;
begin
  v_is_admin := (coalesce(current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'role', '') = 'admin');
  if not v_is_admin then
    raise exception 'FORBIDDEN: 経理のみ実行できます';
  end if;

  select * into v_req from overtime_submission_grant_requests where id = p_request_id for update;
  if not found then
    raise exception 'NOT_FOUND: 依頼が見つかりません';
  end if;
  if v_req.status <> 'open' then
    raise exception 'ALREADY_RESOLVED: この依頼は既に対応済みです';
  end if;

  if p_approve then
    foreach d in array v_req.work_dates loop
      insert into overtime_submission_grants (user_id, work_date, granted_by, note)
      values (v_req.user_id, d, v_uid, p_resolve_note)
      on conflict (user_id, work_date) do update
        set revoked_at = null, revoked_by = null, granted_by = excluded.granted_by, note = excluded.note;
    end loop;
    update overtime_submission_grant_requests
      set status = 'resolved', resolved_at = now(), resolved_by = v_uid, resolve_note = p_resolve_note
      where id = p_request_id and status = 'open';
  else
    update overtime_submission_grant_requests
      set status = 'declined', resolved_at = now(), resolved_by = v_uid, resolve_note = p_resolve_note
      where id = p_request_id and status = 'open';
  end if;

  get diagnostics v_updated = row_count;
  if v_updated = 0 then
    raise exception 'CONFLICT: 他の操作と競合しました。もう一度確認してください';
  end if;
end;
$$;

grant execute on function resolve_overtime_grant_request(uuid, boolean, text) to authenticated;

-- ========================================
-- 8) 通知設定 seed：依頼が届いた時 → 経理（役職＝管理者）全員へ
-- ========================================
insert into notification_settings (event_key, channel, enabled, recipient, subject, template) values
  ('overtime:grant_request', 'site', true,
    '{"roles":["管理者"]}',
    null,
    E'📩 {{申請者名}}さんから締め後申請の許可依頼が届きました'),
  ('overtime:grant_request', 'push', true,
    '{"roles":["管理者"]}',
    null, null),
  ('overtime:grant_request', 'email', false,
    '{"roles":["管理者"]}',
    '締め後申請の許可依頼が届きました',
    E'{{申請者名}}さんから締め後申請の許可依頼が届きました。\n対象日：{{対象日}}\n\n{{リンク}}'),
  ('overtime:grant_declined', 'site', true,
    '{"recipients":["applicant"]}',
    null,
    E'締め後申請の依頼は見送られました'),
  ('overtime:grant_declined', 'push', true,
    '{"recipients":["applicant"]}',
    null, null),
  ('overtime:grant_declined', 'email', false,
    '{"recipients":["applicant"]}',
    '締め後申請の依頼は見送られました',
    E'{{対象日}} の締め後申請の依頼は見送られました。\n理由：{{差し戻し理由}}\n\n{{リンク}}')
on conflict (event_key, channel) do nothing;

-- ========================================
-- 9) 許可の単位が「給与期間まるごと」→「対象日」に変わったため、既存の overtime:grant テンプレート文言を更新
-- ========================================
update notification_settings
  set template = E'{{対象日}} の締め後申請が許可されました。\nこの日の残業・時間調整の新規申請ができます。\n\n{{リンク}}'
  where event_key = 'overtime:grant' and channel = 'email';
