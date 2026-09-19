-- 退職の予約と、退職の手続きのチェック表（1段目）
-- 設計：docs/計画-退職者の申請期間.md（§4・§6・§7-4・§7-5）
--
-- この段では「退職者は今までどおりログインできない」。申請期間を開くのは3段目。
-- ここで作るもの：
--   ・profiles に 退職日／申請の期限／退職時の役職・雇用形態 の列
--   ・退職の予約・取り消し・復活を RPC 1本ずつにまとめる（画面から is_active を直接書かない）
--   ・退職の切り替え（毎晩 0:05 JST・過去の日を入れたときは即時）
--     → 確認者のまま残った未処理の申請を「管理者」に付け替え、誰から移したかを記録する
--   ・チェック表（項目の一覧＋誰がいつ済みにしたか）
--   ・退職日の朝 9:00、必須が残っていればマネージャー以上と管理者にベル1回
--
-- 🚨 日付はすべて日本時間：(now() at time zone 'Asia/Tokyo')::date。current_date は UTC なので使わない
-- 🚨 承認待ち（approval_status='pending'）の人は is_active=false でも退職者ではない。どの関数も弾く

-- ─────────────────────────────────────────
-- 1. profiles の列
-- ─────────────────────────────────────────
alter table public.profiles
  add column if not exists retire_date date,
  add column if not exists retiree_access_until date,
  add column if not exists retired_at timestamptz,
  add column if not exists retired_role_id uuid,  -- 🚨 roles への外部キーは付けない（2本目があると profiles→roles の埋め込みが PGRST201 で全滅する・20260919025525 で外した）
  add column if not exists retired_employment_type text;

comment on column public.profiles.retire_date is '退職日＝在籍の最終日（退職届の日付）。翌日0時(JST)に退職へ切り替わる。予約中も入る';
comment on column public.profiles.retiree_access_until is '退職後にログインして申請できる期限（JST の日付）。初期値は retire_access_default(retire_date)';
comment on column public.profiles.retired_at is '退職に切り替わった日時';
comment on column public.profiles.retired_role_id is '退職に切り替わった時点の役職（退職者に出す機能の判定に使う・以後変えない）';
comment on column public.profiles.retired_employment_type is '退職に切り替わった時点の雇用形態';

-- ─────────────────────────────────────────
-- 2. 期限の初期値：退職日が入る給与期間の「締めの月」の月末
--    給与期間は16日〜翌15日。締めの月＝16日以降なら翌月、15日以前ならその月。
--    例：10/31 → 11/30 ／ 11/15 → 11/30 ／ 11/16 → 12/31
-- ─────────────────────────────────────────
create or replace function public.retire_access_default(p_retire_date date)
returns date
language sql
immutable
set search_path = public
as $$
  select case when p_retire_date is null then null else
    (date_trunc('month',
       case when extract(day from p_retire_date) >= 16
            then p_retire_date + interval '1 month'
            else p_retire_date end)
     + interval '1 month' - interval '1 day')::date
  end;
$$;

-- ─────────────────────────────────────────
-- 3. 付け替えの記録（誰の退職で、どの申請の確認者が管理者に移ったか）
--    🚨 記録を貯める表。退職者のアカウントを削除したら一緒に消える（cascade）
-- ─────────────────────────────────────────
create table if not exists public.retire_reassignments (
  id uuid primary key default gen_random_uuid(),
  retired_user_id uuid not null references public.profiles(id) on delete cascade,
  table_name text not null,
  row_id uuid not null,
  column_name text not null,
  to_user_id uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists retire_reassignments_row_idx on public.retire_reassignments (table_name, row_id);
create index if not exists retire_reassignments_user_idx on public.retire_reassignments (retired_user_id);
alter table public.retire_reassignments enable row level security;
drop policy if exists retire_reassignments_select on public.retire_reassignments;
create policy retire_reassignments_select on public.retire_reassignments
  for select to authenticated using (is_manager_plus());
-- 書き込みは下の security definer 関数だけ（ポリシーを作らない＝画面からは書けない）

-- ─────────────────────────────────────────
-- 4. チェック表
-- ─────────────────────────────────────────
create table if not exists public.retire_checklist_items (
  id uuid primary key default gen_random_uuid(),
  label text not null check (length(btrim(label)) > 0),
  required boolean not null default true,
  sort_order integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.retire_checklist_items enable row level security;
drop policy if exists retire_checklist_items_select on public.retire_checklist_items;
create policy retire_checklist_items_select on public.retire_checklist_items
  for select to authenticated using (is_manager_plus());
drop policy if exists retire_checklist_items_write on public.retire_checklist_items;
create policy retire_checklist_items_write on public.retire_checklist_items
  for all to authenticated using (is_admin()) with check (is_admin());

-- 初期値（2026-09-19 ユーザー確定・すべて必須）。すでに行があれば入れない
insert into public.retire_checklist_items (label, required, sort_order)
select v.label, true, v.ord
from (values
  ('Slack を停止', 10),
  ('Slack のパスワード変更を検討（変更した／不要と判断した）', 20),
  ('Google カレンダーの共有を外す', 30),
  ('退職の書類の記入', 40),
  ('鍵の返却', 50),
  ('制服・備品・名刺の返却（名刺は回収）', 60),
  ('給与の最終精算', 70),
  ('書類を渡す（離職票・源泉徴収票など）', 80)
) as v(label, ord)
where not exists (select 1 from public.retire_checklist_items);

-- 済みの記録。行がある＝済み。退職日を取り消したら消す／アカウントを削除したら消える
create table if not exists public.retire_checklist_checks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  item_id uuid not null references public.retire_checklist_items(id) on delete cascade,
  done_by uuid references public.profiles(id) on delete set null default auth.uid(),
  done_at timestamptz not null default now(),
  unique (user_id, item_id)
);
create index if not exists retire_checklist_checks_user_idx on public.retire_checklist_checks (user_id);
alter table public.retire_checklist_checks enable row level security;
drop policy if exists retire_checklist_checks_select on public.retire_checklist_checks;
create policy retire_checklist_checks_select on public.retire_checklist_checks
  for select to authenticated using (is_manager_plus());
-- 🚨 済みにできるのは「退職日が入っている人」だけ・done_by は自分
drop policy if exists retire_checklist_checks_insert on public.retire_checklist_checks;
create policy retire_checklist_checks_insert on public.retire_checklist_checks
  for insert to authenticated
  with check (
    is_manager_plus()
    and done_by = auth.uid()
    and exists (select 1 from public.profiles p where p.id = user_id and p.retire_date is not null)
  );
drop policy if exists retire_checklist_checks_delete on public.retire_checklist_checks;
create policy retire_checklist_checks_delete on public.retire_checklist_checks
  for delete to authenticated using (is_manager_plus());

-- ─────────────────────────────────────────
-- 5. 退職の切り替え（内部用・画面からは呼べない）
-- ─────────────────────────────────────────
create or replace function public.retire_apply(p_user uuid)
returns integer   -- 付け替えた件数
language plpgsql
security definer
set search_path = public
as $$
declare
  v_admin uuid;
  v_n integer := 0;
  v_c integer;
begin
  -- 在籍中で、退職日が入っていて、承認待ちではない人だけ
  update profiles p
     set is_active = false,
         retired_at = now(),
         retired_role_id = p.role_id,
         retired_employment_type = p.employment_type,
         retiree_access_until = coalesce(p.retiree_access_until, retire_access_default(p.retire_date))
   where p.id = p_user
     and p.is_active = true
     and p.retire_date is not null
     and coalesce(p.approval_status, '') <> 'pending';
  if not found then return 0; end if;

  -- 付け替え先＝「管理者」アカウント（app_metadata.role='admin' かつ在籍・本人以外）。
  -- 🚨 2026-09-18 時点で1つだけ。複数あれば最も古いもの。無ければ付け替えない（記録も残さない）
  select u.id into v_admin
    from auth.users u join profiles pr on pr.id = u.id
   where u.raw_app_meta_data->>'role' = 'admin' and pr.is_active = true and u.id <> p_user
   order by u.created_at
   limit 1;
  if v_admin is null then return 0; end if;

  -- 残業：確定・取り消し以外は、まだ確認者が関わる
  with t as (
    update overtime_reports set reviewer_id = v_admin
     where reviewer_id = p_user and status not in ('confirmed', 'cancelled')
    returning id)
  insert into retire_reassignments (retired_user_id, table_name, row_id, column_name, to_user_id)
  select p_user, 'overtime_reports', id, 'reviewer_id', v_admin from t;
  get diagnostics v_c = row_count; v_n := v_n + v_c;

  -- 勤務変更報告：確認待ち
  with t as (
    update shift_reports set reviewer_id = v_admin
     where reviewer_id = p_user and status = 'pending'
    returning id)
  insert into retire_reassignments (retired_user_id, table_name, row_id, column_name, to_user_id)
  select p_user, 'shift_reports', id, 'reviewer_id', v_admin from t;
  get diagnostics v_c = row_count; v_n := v_n + v_c;

  -- 休暇：1人目・2人目の承認者（受理前）
  with t as (
    update leave_requests set approver_id = v_admin
     where approver_id = p_user and status in ('pending', 'manager_approved')
    returning id)
  insert into retire_reassignments (retired_user_id, table_name, row_id, column_name, to_user_id)
  select p_user, 'leave_requests', id, 'approver_id', v_admin from t;
  get diagnostics v_c = row_count; v_n := v_n + v_c;

  with t as (
    update leave_requests set approver2_id = v_admin
     where approver2_id = p_user and status in ('pending', 'manager_approved')
    returning id)
  insert into retire_reassignments (retired_user_id, table_name, row_id, column_name, to_user_id)
  select p_user, 'leave_requests', id, 'approver2_id', v_admin from t;
  get diagnostics v_c = row_count; v_n := v_n + v_c;

  -- 🚨 備品購入申請（承認者が複数・承認済みの人と未承認の人が混ざる）は自動では付け替えない。
  --    チェック表に「未処理の申請」として出し、既存の［承認者を変更］で直す（2026-09-19）
  return v_n;
end;
$$;

-- 毎晩の切り替え：退職日 < 今日(JST) の在籍者
create or replace function public.retire_daily()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_count integer := 0;
begin
  for r in
    select id from profiles
     where is_active = true
       and retire_date is not null
       and retire_date < (now() at time zone 'Asia/Tokyo')::date
       and coalesce(approval_status, '') <> 'pending'
  loop
    perform retire_apply(r.id);
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ─────────────────────────────────────────
-- 6. 画面から呼ぶ RPC（管理者だけ）
-- ─────────────────────────────────────────
-- 退職の予約（今日も可・過去の日ならその場で切り替え）
create or replace function public.retire_schedule(p_user uuid, p_retire_date date, p_access_until date default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_until date;
  v_moved integer := 0;
  v_applied boolean := false;
begin
  if not is_admin() then raise exception '管理者だけが操作できます' using errcode = '42501'; end if;
  if p_retire_date is null then raise exception '退職日を入れてください'; end if;
  if p_user = auth.uid() then raise exception '自分自身は退職にできません'; end if;

  v_until := coalesce(p_access_until, retire_access_default(p_retire_date));
  if v_until < p_retire_date then raise exception '申請の期限は退職日より後にしてください'; end if;

  update profiles
     set retire_date = p_retire_date,
         retiree_access_until = v_until
   where id = p_user
     and is_active = true
     and coalesce(approval_status, '') <> 'pending';
  if not found then
    raise exception '在籍中の人だけ退職日を入れられます（承認待ち・退職済みの人は対象外）';
  end if;

  -- 過去の日（＝すでに在籍の最終日を過ぎている）はその場で切り替える（2026-09-19 確定）
  if p_retire_date < v_today then
    v_moved := retire_apply(p_user);
    v_applied := true;
  end if;

  return jsonb_build_object(
    'retire_date', p_retire_date,
    'access_until', v_until,
    'applied_now', v_applied,
    'access_expired', v_until < v_today,
    'reassigned', v_moved
  );
end;
$$;

-- 退職日の取り消し（在籍中＝予約中のときだけ）。チェック表も消す（2026-09-19 確定）
create or replace function public.retire_cancel(p_user uuid)
returns integer   -- 消した済みの件数
language plpgsql
security definer
set search_path = public
as $$
declare v_n integer;
begin
  if not is_admin() then raise exception '管理者だけが操作できます' using errcode = '42501'; end if;
  update profiles set retire_date = null, retiree_access_until = null
   where id = p_user and is_active = true and retire_date is not null;
  if not found then raise exception '退職日が予約されている在籍中の人だけ取り消せます'; end if;
  delete from retire_checklist_checks where user_id = p_user;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- 復活（退職済みの人を在籍に戻す）。🚨 退職日を必ず空にする（残すと翌朝また退職になる）
create or replace function public.retire_restore(p_user uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not is_admin() then raise exception '管理者だけが操作できます' using errcode = '42501'; end if;
  update profiles
     set is_active = true,
         retire_date = null,
         retiree_access_until = null,
         retired_at = null,
         retired_role_id = null,
         retired_employment_type = null
   where id = p_user
     and is_active = false
     and coalesce(approval_status, '') <> 'pending';
  if not found then raise exception '退職済みの人だけ復活できます（承認待ちの人は対象外）'; end if;
  delete from retire_checklist_checks where user_id = p_user;
  -- 付け替えの記録（retire_reassignments）は残す：誰の退職で移したかの履歴のため
end;
$$;

-- ─────────────────────────────────────────
-- 7. 退職日の朝 9:00(JST)：必須が残っていれば、マネージャー以上と管理者にベル1回
--    🚨 event_key を付けない＝プッシュは飛ばない（ベルだけ）。宛先は在籍のマネージャー以上＋管理者に絞る
-- ─────────────────────────────────────────
create or replace function public.retire_checklist_notify()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  r record;
  v_sent integer := 0;
  v_c integer;
begin
  for r in
    select p.id, p.name,
           (select count(*) from retire_checklist_items i
             where i.active and i.required
               and not exists (select 1 from retire_checklist_checks c where c.user_id = p.id and c.item_id = i.id)) as remaining
      from profiles p
     where p.retire_date = v_today
       and p.is_active = true
  loop
    continue when r.remaining = 0;
    insert into notifications (user_id, message, sub_message, source_type, reference_id)
    select m.id,
           coalesce(r.name, '') || 'さんの退職の手続きが残っています',
           '本日が退職日です。必須の項目が残り' || r.remaining || '件あります',
           'retire:checklist',
           r.id::text
      from profiles m
     where m.is_active = true
       and m.id <> r.id
       and (role_is_manager_plus(m.id)
            or exists (select 1 from auth.users u where u.id = m.id and u.raw_app_meta_data->>'role' = 'admin'));
    get diagnostics v_c = row_count;
    v_sent := v_sent + v_c;
  end loop;
  return v_sent;
end;
$$;

-- ─────────────────────────────────────────
-- 8. 権限：🚨 新しい関数は anon から明示的に外す（from public だけでは外れない）
-- ─────────────────────────────────────────
revoke execute on function public.retire_access_default(date) from public, anon;
revoke execute on function public.retire_apply(uuid) from public, anon, authenticated;
revoke execute on function public.retire_daily() from public, anon, authenticated;
revoke execute on function public.retire_checklist_notify() from public, anon, authenticated;
revoke execute on function public.retire_schedule(uuid, date, date) from public, anon;
revoke execute on function public.retire_cancel(uuid) from public, anon;
revoke execute on function public.retire_restore(uuid) from public, anon;
grant execute on function public.retire_access_default(date) to authenticated;
grant execute on function public.retire_schedule(uuid, date, date) to authenticated;
grant execute on function public.retire_cancel(uuid) to authenticated;
grant execute on function public.retire_restore(uuid) to authenticated;

-- ─────────────────────────────────────────
-- 9. cron（pg_cron は UTC）
--    切り替え：毎日 0:05 JST ＝ 15:05 UTC ／ 知らせ：毎日 9:00 JST ＝ 0:00 UTC
--    🚨 鍵を使わない（SQL の関数を直接呼ぶ）
-- ─────────────────────────────────────────
select cron.unschedule(jobid) from cron.job where jobname in ('retire-daily', 'retire-checklist-notify-daily');
select cron.schedule('retire-daily', '5 15 * * *', $cron$select public.retire_daily();$cron$);
select cron.schedule('retire-checklist-notify-daily', '0 0 * * *', $cron$select public.retire_checklist_notify();$cron$);
