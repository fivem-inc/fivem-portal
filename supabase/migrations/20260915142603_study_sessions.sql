-- ③ 勉強会（毎週の定例）2026-09-15
-- 設計・決めたこと・レビューは docs/計画-管理画面の開放.md の 5-5・5-6。
--
-- ・勉強会そのもの（study_sessions・ID は変わらない）／版（study_session_versions・曜日・開始・長さ・校・階・メモ・いつから〜いつまで）／
--   参加者（study_session_members・版×人）に分ける。将来「その日だけ中止」は (session_id, 日付) の表を足すだけで済む
-- ・⚠️ 印（勤務時間外・別の校など）は保存しない。画面が週のシフトから計算する。「確認した」だけ study_session_acks に残す
-- ・書き込みは study_sessions_save だけ（確かめは書き込みの前に全部。書き込み以降は raise だけ＝途中で失敗したら何も残さない）
-- ・終わらせるときは、先の日付の変更も一緒に取り消す（勤務表の「先の版は残す」とは逆・ユーザー確定）
-- ・本人に見せる：app_settings 'study_sessions_show_self'（最初は false・書き込みは管理者だけ＝今の決まりのまま）。
--   本人は my_study_sessions で自分が参加者の勉強会だけを読む（切り替えも関数の中で確かめる）
-- ・掃除の cron は作らない：版と確認は人が押したときにしか増えない（将来の「その日だけ中止」の表は1年で消す cron と一緒に作る）

-- ───────────────────────────────────────────
-- 1. 表
-- ───────────────────────────────────────────
create table if not exists public.study_sessions (
  id uuid primary key default gen_random_uuid(),
  created_by uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.study_session_versions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.study_sessions(id) on delete cascade,
  day_kind text not null check (day_kind in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')),
  start_time time not null,
  duration_minutes integer not null check (duration_minutes between 5 and 240),
  location text,
  floor text,
  memo text check (memo is null or length(memo) <= 200),
  valid_from date not null,
  valid_to date,
  saved_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint study_session_versions_range check (valid_to is null or valid_to >= valid_from),
  constraint study_session_versions_no_overlap
    exclude using gist (session_id with =, daterange(valid_from, valid_to, '[]') with &&)
);

create index if not exists study_session_versions_session_idx on public.study_session_versions (session_id, valid_from);

drop trigger if exists study_session_versions_updated_at on public.study_session_versions;
create trigger study_session_versions_updated_at
  before update on public.study_session_versions
  for each row execute function public.set_updated_at();

-- 🚨 参加者は profiles に CASCADE（2人共通の delete-user を止めないため）。「2人以上」は保存の関数で確かめ、画面は ⚠️ で出す
create table if not exists public.study_session_members (
  version_id uuid not null references public.study_session_versions(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  sort_order integer not null default 0,
  primary key (version_id, user_id)
);

create index if not exists study_session_members_user_idx on public.study_session_members (user_id);

-- 「確認した」：版×人×ずれの中身（issue_key）。ずれ方が変わると issue_key が変わり、また印が出る
create table if not exists public.study_session_acks (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.study_session_versions(id) on delete cascade,
  issue_key text not null check (length(issue_key) between 1 and 300),
  acked_by uuid not null,
  acked_at timestamptz not null default now(),
  unique (version_id, issue_key)
);

comment on table public.study_sessions is '勉強会（毎週の定例）そのもの。ID は版が変わっても変わらない（2026-09-15）';
comment on table public.study_session_versions is '勉強会の版（曜日・開始・長さ・校・階・メモ・valid_from/valid_to）。書くのは study_sessions_save だけ';
comment on table public.study_session_members is '勉強会の版の参加者（並び順つき）。書くのは study_sessions_save だけ';
comment on table public.study_session_acks is '勉強会の ⚠️ 印を「確認した」記録（版×ずれの中身）';

alter table public.study_sessions enable row level security;
alter table public.study_session_versions enable row level security;
alter table public.study_session_members enable row level security;
alter table public.study_session_acks enable row level security;

drop policy if exists study_sessions_select on public.study_sessions;
create policy study_sessions_select on public.study_sessions
  for select to authenticated using ((select public.can_manage_admin_tab('shift_patterns')));

drop policy if exists study_session_versions_select on public.study_session_versions;
create policy study_session_versions_select on public.study_session_versions
  for select to authenticated using ((select public.can_manage_admin_tab('shift_patterns')));

drop policy if exists study_session_members_select on public.study_session_members;
create policy study_session_members_select on public.study_session_members
  for select to authenticated using ((select public.can_manage_admin_tab('shift_patterns')));

drop policy if exists study_session_acks_select on public.study_session_acks;
create policy study_session_acks_select on public.study_session_acks
  for select to authenticated using ((select public.can_manage_admin_tab('shift_patterns')));

drop policy if exists study_session_acks_insert on public.study_session_acks;
create policy study_session_acks_insert on public.study_session_acks
  for insert to authenticated
  with check ((select public.can_manage_admin_tab('shift_patterns')) and acked_by = (select auth.uid()));

-- ───────────────────────────────────────────
-- 2. 階の選択肢（校ごと）と、本人に見せる切り替え
-- ───────────────────────────────────────────
insert into public.master_options (category, value, sort_order)
select 'floor_四条本校', f.value, f.ord
from (values ('3F', 1), ('4F', 2), ('5F', 3), ('6F', 4)) as f(value, ord)
where not exists (select 1 from public.master_options mo where mo.category = 'floor_四条本校' and mo.value = f.value);

insert into public.app_settings (key, value)
values ('study_sessions_show_self', 'false'::jsonb)
on conflict (key) do nothing;

-- ───────────────────────────────────────────
-- 3. 開いた時点の目印（勤務表の目印とは別）
-- ───────────────────────────────────────────
create or replace function public.study_sessions_token()
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.can_manage_admin_tab('shift_patterns') then
    raise exception '権限がありません' using errcode = '42501';
  end if;
  return md5(
    coalesce((select string_agg(v.id::text || v.updated_at::text || coalesce(v.valid_to::text, '-'), ',' order by v.id)
                from public.study_session_versions v), '')
    || '|' ||
    coalesce((select string_agg(m.version_id::text || m.user_id::text || m.sort_order::text, ',' order by m.version_id, m.user_id)
                from public.study_session_members m), '')
  );
end;
$$;

revoke execute on function public.study_sessions_token() from public;
revoke execute on function public.study_sessions_token() from anon;
grant execute on function public.study_sessions_token() to authenticated;

-- ───────────────────────────────────────────
-- 4. 保存
-- ───────────────────────────────────────────
-- p_payload：
--   追加・修正 { "action":"upsert", "session_id": null|uuid, "apply_from":"2026-10-01", "confirm_past":false, "base_token":"…",
--                "day_kind":"mon", "start":"12:30", "duration_minutes":30, "location":"四条本校"|null, "floor":"5F"|null,
--                "memo":"…"|null, "members":[uuid, …] }
--   終わらせる { "action":"end", "session_id": uuid, "apply_from":"2026-09-20"（この日まで）, "confirm_past":false, "base_token":"…" }
-- 戻り値：{ ok, reason('past_confirm'|'stale'|null), session_id, changed, deleted_future:[{valid_from, day_kind, start}] }
create or replace function public.study_sessions_save(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_action text;
  v_from date;
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_session uuid;
  v_day text;
  v_start time;
  v_dur integer;
  v_loc text;
  v_floor text;
  v_memo text;
  v_members uuid[];
  v_cur public.study_session_versions%rowtype;
  v_found boolean;
  v_next date;
  v_to date;
  v_version uuid;
  v_cur_members uuid[];
  v_deleted jsonb := '[]'::jsonb;
begin
  if not public.can_manage_admin_tab('shift_patterns') then
    raise exception '勉強会を保存する権限がありません' using errcode = '42501';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception '保存する内容がありません' using errcode = '22023';
  end if;

  -- ── 確かめ（🚨 書き込みより前に全部済ませる） ──
  v_action := coalesce(p_payload->>'action', 'upsert');
  if v_action not in ('upsert', 'end') then
    raise exception '操作の指定が正しくありません' using errcode = '22023';
  end if;
  if coalesce(p_payload->>'apply_from', '') !~ '^\d{4}-\d{2}-\d{2}$' then
    raise exception '日付を入れてください' using errcode = '22023';
  end if;
  v_from := (p_payload->>'apply_from')::date;
  if coalesce(p_payload->>'session_id', '') <> '' then
    if (p_payload->>'session_id') !~ '^[0-9a-fA-F-]{36}$' then
      raise exception '勉強会の指定が正しくありません' using errcode = '22023';
    end if;
    v_session := (p_payload->>'session_id')::uuid;
    if not exists (select 1 from public.study_sessions s where s.id = v_session) then
      raise exception '勉強会が見つかりません（ほかの人が終わらせた可能性があります）' using errcode = 'P0002';
    end if;
  end if;
  if v_action = 'end' and v_session is null then
    raise exception '終わらせる勉強会を選んでください' using errcode = '22023';
  end if;

  if v_action = 'upsert' then
    v_day := p_payload->>'day_kind';
    if v_day is null or v_day not in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun') then
      raise exception '曜日を選んでください' using errcode = '22023';
    end if;
    if coalesce(p_payload->>'start', '') !~ '^([01]?[0-9]|2[0-3]):[0-5][0-9]$' then
      raise exception '開始の時刻は「12:30」の形で入れてください' using errcode = '22023';
    end if;
    v_start := (p_payload->>'start')::time;
    if coalesce(p_payload->>'duration_minutes', '') !~ '^[0-9]{1,3}$' then
      raise exception '長さは5〜240分で入れてください' using errcode = '22023';
    end if;
    v_dur := (p_payload->>'duration_minutes')::int;
    if v_dur < 5 or v_dur > 240 then
      raise exception '長さは5〜240分で入れてください' using errcode = '22023';
    end if;
    if extract(hour from v_start) * 60 + extract(minute from v_start) + v_dur > 1440 then
      raise exception '日をまたぐ勉強会は入れられません' using errcode = '22023';
    end if;
    v_loc := nullif(btrim(coalesce(p_payload->>'location', '')), '');
    if v_loc is not null and not exists (select 1 from public.master_options mo where mo.category = 'workplace' and mo.value = v_loc) then
      raise exception '「%」という校はありません', v_loc using errcode = '22023';
    end if;
    v_floor := nullif(btrim(coalesce(p_payload->>'floor', '')), '');
    if v_floor is not null and (v_loc is null or not exists (
      select 1 from public.master_options mo where mo.category = 'floor_' || v_loc and mo.value = v_floor)) then
      raise exception '階の指定が正しくありません' using errcode = '22023';
    end if;
    v_memo := nullif(btrim(coalesce(p_payload->>'memo', '')), '');
    if v_memo is not null and length(v_memo) > 200 then
      raise exception '内容のメモは200文字までです' using errcode = '22023';
    end if;
    if jsonb_typeof(p_payload->'members') is distinct from 'array' then
      raise exception '参加者を選んでください' using errcode = '22023';
    end if;
    -- 🚨 null・形の崩れを先に断る（数え方で「同じ人が2回」と誤った理由を出さないように）
    if exists (select 1 from jsonb_array_elements(p_payload->'members') x
               where jsonb_typeof(x.value) <> 'string' or (x.value #>> '{}') !~ '^[0-9a-fA-F-]{36}$') then
      raise exception '参加者の指定が正しくありません' using errcode = '22023';
    end if;
    select array_agg((x.value)::uuid order by x.ord) into v_members
      from jsonb_array_elements_text(p_payload->'members') with ordinality as x(value, ord);
    if coalesce(cardinality(v_members), 0) < 2 then
      raise exception '参加者は2人以上にしてください' using errcode = '22023';
    end if;
    if (select count(distinct u) from unnest(v_members) u) <> cardinality(v_members) then
      raise exception '同じ人が2回入っています' using errcode = '22023';
    end if;
    if exists (select 1 from unnest(v_members) u where not exists (select 1 from public.profiles p where p.id = u)) then
      raise exception 'スタッフが見つかりません' using errcode = 'P0002';
    end if;
  end if;

  if v_from < v_today and coalesce((p_payload->>'confirm_past')::boolean, false) is not true then
    return jsonb_build_object('ok', false, 'reason', 'past_confirm');
  end if;

  perform pg_advisory_xact_lock(hashtext('study_sessions_save'));
  if coalesce(p_payload->>'base_token', '') <> public.study_sessions_token() then
    return jsonb_build_object('ok', false, 'reason', 'stale');
  end if;

  -- ── ここから書き込み（🚨 以降は ok:false を返さない。失敗は raise で全部取り消す） ──
  if v_action = 'end' then
    -- apply_from ＝ この日まで。先の日付の変更も一緒に取り消す
    select coalesce(jsonb_agg(jsonb_build_object('valid_from', v.valid_from, 'day_kind', v.day_kind, 'start', to_char(v.start_time, 'HH24:MI'))
                              order by v.valid_from), '[]'::jsonb)
      into v_deleted
      from public.study_session_versions v
     where v.session_id = v_session and v.valid_from > v_from;
    delete from public.study_session_versions v where v.session_id = v_session and v.valid_from > v_from;
    update public.study_session_versions v set valid_to = v_from, saved_by = auth.uid()
     where v.session_id = v_session and v.valid_from <= v_from and (v.valid_to is null or v.valid_to > v_from);
    if not exists (select 1 from public.study_session_versions v where v.session_id = v_session) then
      delete from public.study_sessions s where s.id = v_session;
    end if;
    return jsonb_build_object('ok', true, 'reason', null, 'session_id', v_session, 'changed', true, 'deleted_future', v_deleted);
  end if;

  if v_session is null then
    insert into public.study_sessions (created_by) values (auth.uid()) returning id into v_session;
    insert into public.study_session_versions
      (session_id, day_kind, start_time, duration_minutes, location, floor, memo, valid_from, valid_to, saved_by)
    values (v_session, v_day, v_start, v_dur, v_loc, v_floor, v_memo, v_from, null, auth.uid())
    returning id into v_version;
  else
    select * into v_cur from public.study_session_versions v
     where v.session_id = v_session and v.valid_from <= v_from and (v.valid_to is null or v.valid_to >= v_from);
    v_found := found;
    if v_found then
      select array_agg(m.user_id order by m.sort_order, m.user_id) into v_cur_members
        from public.study_session_members m where m.version_id = v_cur.id;
      if v_cur.day_kind = v_day and v_cur.start_time = v_start and v_cur.duration_minutes = v_dur
         and v_cur.location is not distinct from v_loc and v_cur.floor is not distinct from v_floor
         and v_cur.memo is not distinct from v_memo and v_cur_members = v_members then
        return jsonb_build_object('ok', true, 'reason', null, 'session_id', v_session, 'changed', false, 'deleted_future', '[]'::jsonb);
      end if;
      if v_cur.valid_from = v_from then
        update public.study_session_versions
           set day_kind = v_day, start_time = v_start, duration_minutes = v_dur, location = v_loc,
               floor = v_floor, memo = v_memo, saved_by = auth.uid()
         where id = v_cur.id;
        delete from public.study_session_members m where m.version_id = v_cur.id;
        v_version := v_cur.id;
      else
        v_to := v_cur.valid_to;
        update public.study_session_versions set valid_to = v_from - 1 where id = v_cur.id;
        insert into public.study_session_versions
          (session_id, day_kind, start_time, duration_minutes, location, floor, memo, valid_from, valid_to, saved_by)
        values (v_session, v_day, v_start, v_dur, v_loc, v_floor, v_memo, v_from, v_to, auth.uid())
        returning id into v_version;
      end if;
    else
      -- この日に効いている版が無い（始まる前・終わったあと）。先の版があればその前日まで
      select min(v.valid_from) into v_next from public.study_session_versions v
       where v.session_id = v_session and v.valid_from > v_from;
      insert into public.study_session_versions
        (session_id, day_kind, start_time, duration_minutes, location, floor, memo, valid_from, valid_to, saved_by)
      values (v_session, v_day, v_start, v_dur, v_loc, v_floor, v_memo, v_from, v_next - 1, auth.uid())
      returning id into v_version;
    end if;
  end if;

  insert into public.study_session_members (version_id, user_id, sort_order)
  select v_version, t.u, t.ord from unnest(v_members) with ordinality as t(u, ord);

  return jsonb_build_object('ok', true, 'reason', null, 'session_id', v_session, 'changed', true, 'deleted_future', '[]'::jsonb);
end;
$$;

comment on function public.study_sessions_save(jsonb) is
  '勉強会の追加・修正（版を足す）・終わらせる（先の変更も取り消す）。確かめは書き込みの前に全部、stale／past_confirm で断る（2026-09-15）';

revoke execute on function public.study_sessions_save(jsonb) from public;
revoke execute on function public.study_sessions_save(jsonb) from anon;
grant execute on function public.study_sessions_save(jsonb) to authenticated;

-- ───────────────────────────────────────────
-- 5. 本人に見せる（切り替えがオンのときだけ・自分が参加者の勉強会だけ）
-- ───────────────────────────────────────────
-- 🚨 参加者の表の RLS で「同じ版の人」を書くと自分を参照して無限に回るので、関数にした
create or replace function public.my_study_sessions(p_date date)
returns table (
  session_id uuid, day_kind text, start_time time, duration_minutes integer,
  location text, floor text, memo text, valid_from date, valid_to date, member_names text[]
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_date date := coalesce(p_date, (now() at time zone 'Asia/Tokyo')::date);
begin
  if auth.uid() is null then
    return;
  end if;
  if not exists (select 1 from public.app_settings s where s.key = 'study_sessions_show_self' and s.value = 'true'::jsonb) then
    return;
  end if;
  return query
  select v.session_id, v.day_kind, v.start_time, v.duration_minutes, v.location, v.floor, v.memo, v.valid_from, v.valid_to,
         array(select p.name from public.study_session_members m2 join public.profiles p on p.id = m2.user_id
               where m2.version_id = v.id order by m2.sort_order)
  from public.study_session_versions v
  where v.valid_from <= v_date and (v.valid_to is null or v.valid_to >= v_date)
    and exists (select 1 from public.study_session_members m where m.version_id = v.id and m.user_id = auth.uid())
  order by array_position(array['mon','tue','wed','thu','fri','sat','sun'], v.day_kind), v.start_time;
end;
$$;

comment on function public.my_study_sessions(date) is
  '本人が参加者の勉強会（その日に効いている版）。app_settings study_sessions_show_self が true のときだけ返す（2026-09-15）';

revoke execute on function public.my_study_sessions(date) from public;
revoke execute on function public.my_study_sessions(date) from anon;
grant execute on function public.my_study_sessions(date) to authenticated;
