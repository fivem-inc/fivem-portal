-- 残業・時間管理：締めロック（A）／経理からの締め後申請許可（B）／振替休日の自己完結差分＋二重計上防止（C）
-- すべて additive・冪等。既存行の値は変更しない（振替の差分は「以降適用」＝新規/再提出行からnet計算）。
-- 締め＝支給月17日（支給月＝給与期間終了日の月＝pay_period_start月+1）。取消の締めも別途Edgeで17日に統一。

-- ========================================
-- C-1) 振替休日：振替元の勤務時刻を保存する列（自己完結の差分計算に使用）
--   furikae_origin_date / furikae_origin_location は既存（20260728100000）。
-- ========================================
alter table overtime_reports
  add column if not exists furikae_origin_start          time,
  add column if not exists furikae_origin_end            time,
  add column if not exists furikae_origin_break_minutes  int,
  add column if not exists furikae_origin_labor_minutes  int;

-- ========================================
-- B) 経理からの締め後申請許可（許可窓モデル）
--   対象者×給与期間ごとに1つの有効な許可窓。revoked_at でソフト取消。管理者のみ付与。
-- ========================================
create table if not exists overtime_submission_grants (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  pay_period_start date not null,
  granted_by       uuid not null references auth.users(id),
  note             text,
  revoked_at       timestamptz,
  revoked_by       uuid references auth.users(id),
  created_at       timestamptz not null default now(),
  -- 給与期間開始日は必ず16日
  check (extract(day from pay_period_start) = 16)
);

-- 対象者×期間で1行のみ（再付与は同じ行を revoked_at=null に戻す upsert で行う。
-- PostgREST の upsert(onConflict) は部分ユニークインデックスを ON CONFLICT のターゲットにできないため、
-- 通常のユニーク制約にしている＝取消の履歴は「直近1回分」のみ保持される簡易モデル）
create unique index if not exists uq_overtime_grant_user_period
  on overtime_submission_grants(user_id, pay_period_start);

create index if not exists idx_overtime_grants_user on overtime_submission_grants(user_id);

alter table overtime_submission_grants enable row level security;

-- 本人は自分の許可窓を読める（UIの「締め後申請が許可されています」案内に使用）
drop policy if exists "overtime_grants_select_own" on overtime_submission_grants;
create policy "overtime_grants_select_own" on overtime_submission_grants
  for select using (
    user_id = auth.uid()
    or (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
  );

-- 付与・取消は管理者のみ
drop policy if exists "overtime_grants_admin_all" on overtime_submission_grants;
create policy "overtime_grants_admin_all" on overtime_submission_grants
  for all using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- ========================================
-- A) 締めロック：本人の新規申請(manual)は、対象日の給与期間の締め（支給月17日）を過ぎたら不可。
--   ・leave_auto（自動計上）は対象外
--   ・service_role / admin は対象外（Edge受理・管理者代行を誤爆させない）
--   ・経理の許可窓（B）があれば通す
--   ・INSERT のみ（既存申請の実績報告=UPDATEは、申請が締め前に成立していれば締め後でも報告可）
--   ・pay_period_start は work_date から正規化してから判定（クライアントの詐称防止）
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
  -- 自動計上は対象外
  if new.entry_type <> 'manual' then
    return new;
  end if;

  -- service_role / admin は締めロックを適用しない
  v_role     := coalesce(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '');
  v_app_role := coalesce(current_setting('request.jwt.claims', true)::jsonb -> 'app_metadata' ->> 'role', '');
  if v_role = 'service_role' or v_app_role = 'admin' then
    return new;
  end if;

  -- work_date → 給与期間開始日（16日始まり）を正規化
  if extract(day from new.work_date) >= 16 then
    v_pps := date_trunc('month', new.work_date)::date + 15;                       -- 当月16日
  else
    v_pps := (date_trunc('month', new.work_date) - interval '1 month')::date + 15; -- 前月16日
  end if;
  new.pay_period_start := v_pps;

  -- 締め切り＝支給月（開始月+1）の17日
  v_cutoff := (date_trunc('month', v_pps + interval '1 month'))::date + 16;       -- 翌月1日 + 16 = 17日

  if v_today > v_cutoff then
    -- 経理の有効な許可窓があれば通す
    select count(*) into v_grant
    from overtime_submission_grants g
    where g.user_id = new.applicant_id
      and g.pay_period_start = v_pps
      and g.revoked_at is null;

    if v_grant = 0 then
      raise exception 'OVERTIME_CLOSED: この対象日の給与期間は締め切り（%）を過ぎています。経理に申請の許可を依頼してください。', to_char(v_cutoff, 'YYYY/MM/DD')
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_overtime_submission_window on overtime_reports;
create trigger trg_enforce_overtime_submission_window
  before insert on overtime_reports
  for each row execute function enforce_overtime_submission_window();

-- ========================================
-- C-2) 振替休日の二重計上防止：
--   振替休日(furikae_off)は「振替元の勤務時間」を自身の差分に含める（自己完結）。
--   よって、振替元の日付に別途 manual 申請（休日出勤等）があると二重計上になる。両方向をブロックする。
--   ・振替休日を出す時：振替元日に非cancelledのmanual行があれば不可
--   ・manual行を出す時：その日を振替元にしている非cancelledの振替休日があれば不可
-- ========================================
create or replace function enforce_furikae_no_double_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_furikae boolean := ('furikae_off' = any(coalesce(new.application_types, '{}')));
  v_hit int;
begin
  -- 取消行は対象外
  if new.status = 'cancelled' or new.entry_type <> 'manual' then
    return new;
  end if;

  if v_is_furikae then
    -- 振替休日：振替元日に別の非cancelled manual行があればブロック
    if new.furikae_origin_date is not null then
      select count(*) into v_hit
      from overtime_reports r
      where r.applicant_id = new.applicant_id
        and r.entry_type = 'manual'
        and r.status <> 'cancelled'
        and r.id <> new.id
        and r.work_date = new.furikae_origin_date;
      if v_hit > 0 then
        raise exception 'FURIKAE_DUP_ORIGIN: 振替元の日（%）には別の申請があります。振替休日は振替元の勤務時間を含むため、その日を別途「休日出勤」等で申請しないでください。', to_char(new.furikae_origin_date, 'YYYY/MM/DD')
          using errcode = 'check_violation';
      end if;
    end if;
  else
    -- 通常のmanual行：この日を振替元にしている非cancelledの振替休日があればブロック
    select count(*) into v_hit
    from overtime_reports r
    where r.applicant_id = new.applicant_id
      and r.entry_type = 'manual'
      and r.status <> 'cancelled'
      and r.id <> new.id
      and ('furikae_off' = any(coalesce(r.application_types, '{}')))
      and r.furikae_origin_date = new.work_date;
    if v_hit > 0 then
      raise exception 'FURIKAE_DUP_WORKDATE: この日（%）は振替休日の振替元として申請済みです。二重計上になるため、この日は別途申請できません。', to_char(new.work_date, 'YYYY/MM/DD')
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_enforce_furikae_no_double_count on overtime_reports;
create trigger trg_enforce_furikae_no_double_count
  before insert or update on overtime_reports
  for each row execute function enforce_furikae_no_double_count();

-- ========================================
-- B) 通知設定 seed（管理画面「通知設定」の overtime:grant として編集可能に）
--   締め後申請を許可した時 → 許可された本人へ。site=ON・push=ON（EVENT_MAPに追加済み）・email=OFF（新規イベントの既定に合わせる）
-- ========================================
insert into notification_settings (event_key, channel, enabled, recipient, subject, template) values
  ('overtime:grant', 'site',  true,  '{"recipients":["applicant"]}', null, null),
  ('overtime:grant', 'push',  true,  '{"recipients":["applicant"]}', null, null),
  ('overtime:grant', 'email', false, '{"recipients":["applicant"]}',
     '締め後の残業・時間調整申請が許可されました',
     E'{{給与期間}} の締め後申請が許可されました。\nこの期間の残業・時間調整の新規申請ができます。\n\n{{リンク}}')
on conflict (event_key, channel) do nothing;
