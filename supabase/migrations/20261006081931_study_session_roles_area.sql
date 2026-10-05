-- 勉強会に「講師／参加」と「部門」を持たせる（2026-10-06 ユーザー確定）
--
-- きっかけ：社長「参加者で合ってるけど、講師・参加も入れたい」「こども・大人・管理部、どこの勉強会か入れられる？」
-- 決めたこと：
--   ・参加者を1人ずつ「講師」か「参加」にする（講師1人以上・参加1人以上）。勤務表の欄は講師が先（「12:30(30)濱口・馬場」）
--   ・勉強会ごとに部門（shift_work_areas）を持つ（任意）。画面は作るときに講師のメインの部門を入れておく
--   ・いまの版は、紙の書き方どおり「先頭の人＝講師」、部門＝講師のメインの部門で埋める
-- 🚨 2つの関数は本番の実定義（pg_get_functiondef・2026-10-06 取得）から起こした。差分は「2026-10-06」の注記の行だけ
-- 🚨 my_study_sessions（本人に見せる）は触らない（名前は sort_order 順＝講師が先で返る）
--
-- ロールバック手順:
--   本番の旧定義（このファイルの差分を戻したもの）で study_sessions_save・study_sessions_token を create or replace
--   alter table public.study_session_versions drop column if exists area_id;
--   alter table public.study_session_members drop column if exists role;

-- 1. 列
alter table public.study_session_members
  add column if not exists role text not null default 'member';
alter table public.study_session_members drop constraint if exists study_session_members_role_check;
alter table public.study_session_members
  add constraint study_session_members_role_check check (role in ('teacher', 'member'));
comment on column public.study_session_members.role is '講師（teacher）か参加（member）か（2026-10-06）';

alter table public.study_session_versions
  add column if not exists area_id uuid null references public.shift_work_areas(id) on delete set null;
comment on column public.study_session_versions.area_id is '勉強会の部門（こども・大人・管理部など・任意・2026-10-06）';

-- 2. いまの版を埋める（先頭＝講師・部門＝講師のメインの部門）
update public.study_session_members m set role = 'teacher'
 where m.sort_order = (select min(m2.sort_order) from public.study_session_members m2 where m2.version_id = m.version_id)
   and m.role <> 'teacher';
update public.study_session_versions v
   set area_id = (select sm.area_id from public.study_session_members m
                    join public.staff_main_work_areas sm on sm.user_id = m.user_id
                   where m.version_id = v.id and m.role = 'teacher'
                   order by m.sort_order limit 1)
 where v.area_id is null;

-- 3. 保存（本番の実定義から）
CREATE OR REPLACE FUNCTION public.study_sessions_save(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  v_teachers uuid[];       -- 2026-10-06：講師（参加者のうちの何人か）
  v_cur_teachers uuid[];   -- 2026-10-06
  v_area uuid;             -- 2026-10-06：部門（shift_work_areas）
  v_area_given boolean;    -- 2026-10-06：payload に area_id のキーがあるか（無ければ今の版の部門を引き継ぐ）
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
    -- 2026-10-06：講師。キーが無い（古い画面）ときは先頭の人を講師にする
    if p_payload ? 'teachers' then
      if jsonb_typeof(p_payload->'teachers') <> 'array'
         or exists (select 1 from jsonb_array_elements(p_payload->'teachers') x
                    where jsonb_typeof(x.value) <> 'string' or (x.value #>> '{}') !~ '^[0-9a-fA-F-]{36}$') then
        raise exception '講師の指定が正しくありません' using errcode = '22023';
      end if;
      select array_agg((x.value)::uuid order by x.ord) into v_teachers
        from jsonb_array_elements_text(p_payload->'teachers') with ordinality as x(value, ord);
    else
      v_teachers := array[v_members[1]];
    end if;
    if coalesce(cardinality(v_teachers), 0) < 1 then
      raise exception '講師を1人以上選んでください' using errcode = '22023';
    end if;
    if exists (select 1 from unnest(v_teachers) t where not (t = any(v_members))) then
      raise exception '講師は参加者の中から選んでください' using errcode = '22023';
    end if;
    if cardinality(v_teachers) >= cardinality(v_members) then
      raise exception '参加する人（講師以外）を1人以上選んでください' using errcode = '22023';
    end if;
    -- 並びは講師が先（勤務表の「12:30(30)濱口・馬場」も講師が先に出る）
    v_members := v_teachers || array(select u from unnest(v_members) with ordinality as t(u, ord) where not (u = any(v_teachers)) order by ord);
    -- 2026-10-06：部門
    v_area_given := p_payload ? 'area_id';
    if coalesce(p_payload->>'area_id', '') <> '' then
      if (p_payload->>'area_id') !~ '^[0-9a-fA-F-]{36}$'
         or not exists (select 1 from public.shift_work_areas a where a.id = (p_payload->>'area_id')::uuid) then
        raise exception '部門が見つかりません' using errcode = '22023';
      end if;
      v_area := (p_payload->>'area_id')::uuid;
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
      (session_id, day_kind, start_time, duration_minutes, location, floor, memo, valid_from, valid_to, saved_by, area_id)
    values (v_session, v_day, v_start, v_dur, v_loc, v_floor, v_memo, v_from, null, auth.uid(), v_area)
    returning id into v_version;
  else
    select * into v_cur from public.study_session_versions v
     where v.session_id = v_session and v.valid_from <= v_from and (v.valid_to is null or v.valid_to >= v_from);
    v_found := found;
    if v_found then
      if not v_area_given then v_area := v_cur.area_id; end if;   -- 2026-10-06
      select array_agg(m.user_id order by m.sort_order, m.user_id) into v_cur_members
        from public.study_session_members m where m.version_id = v_cur.id;
      select array_agg(m.user_id order by m.sort_order, m.user_id) into v_cur_teachers   -- 2026-10-06
        from public.study_session_members m where m.version_id = v_cur.id and m.role = 'teacher';
      if v_cur.day_kind = v_day and v_cur.start_time = v_start and v_cur.duration_minutes = v_dur
         and v_cur.location is not distinct from v_loc and v_cur.floor is not distinct from v_floor
         and v_cur.memo is not distinct from v_memo and v_cur_members = v_members
         and v_cur.area_id is not distinct from v_area and v_cur_teachers is not distinct from v_teachers then   -- 2026-10-06
        return jsonb_build_object('ok', true, 'reason', null, 'session_id', v_session, 'changed', false, 'deleted_future', '[]'::jsonb);
      end if;
      if v_cur.valid_from = v_from then
        update public.study_session_versions
           set day_kind = v_day, start_time = v_start, duration_minutes = v_dur, location = v_loc,
               floor = v_floor, memo = v_memo, area_id = v_area, saved_by = auth.uid()   -- 2026-10-06：area_id
         where id = v_cur.id;
        delete from public.study_session_members m where m.version_id = v_cur.id;
        v_version := v_cur.id;
      else
        v_to := v_cur.valid_to;
        update public.study_session_versions set valid_to = v_from - 1 where id = v_cur.id;
        insert into public.study_session_versions
          (session_id, day_kind, start_time, duration_minutes, location, floor, memo, valid_from, valid_to, saved_by, area_id)
        values (v_session, v_day, v_start, v_dur, v_loc, v_floor, v_memo, v_from, v_to, auth.uid(), v_area)
        returning id into v_version;
      end if;
    else
      -- この日に効いている版が無い（始まる前・終わったあと）。先の版があればその前日まで
      select min(v.valid_from) into v_next from public.study_session_versions v
       where v.session_id = v_session and v.valid_from > v_from;
      insert into public.study_session_versions
        (session_id, day_kind, start_time, duration_minutes, location, floor, memo, valid_from, valid_to, saved_by, area_id)
      values (v_session, v_day, v_start, v_dur, v_loc, v_floor, v_memo, v_from, v_next - 1, auth.uid(), v_area)
      returning id into v_version;
    end if;
  end if;

  insert into public.study_session_members (version_id, user_id, sort_order, role)   -- 2026-10-06：role
  select v_version, t.u, t.ord, case when t.u = any(v_teachers) then 'teacher' else 'member' end
    from unnest(v_members) with ordinality as t(u, ord);

  return jsonb_build_object('ok', true, 'reason', null, 'session_id', v_session, 'changed', true, 'deleted_future', '[]'::jsonb);
end;
$function$;

-- 4. 目印（講師・部門の変更も含める・本番の実定義から）
CREATE OR REPLACE FUNCTION public.study_sessions_token()
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if not public.can_manage_admin_tab('shift_patterns') then
    raise exception '権限がありません' using errcode = '42501';
  end if;
  return md5(
    coalesce((select string_agg(v.id::text || v.updated_at::text || coalesce(v.valid_to::text, '-') || coalesce(v.area_id::text, '-'), ',' order by v.id)
                from public.study_session_versions v), '')
    || '|' ||
    coalesce((select string_agg(m.version_id::text || m.user_id::text || m.sort_order::text || m.role, ',' order by m.version_id, m.user_id)
                from public.study_session_members m), '')
  );
end;
$function$;

-- 確認用:
--   select count(*) filter (where role='teacher'), count(*) from study_session_members;
--   select count(*) filter (where area_id is not null), count(*) from study_session_versions;
