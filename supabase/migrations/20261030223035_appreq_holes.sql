-- 申請の依頼（application_requests）の今ある穴を直す（2026-10-30・連絡板のアンケート 段2-0・計画 docs/計画-連絡板のアンケート.md の 18・19）
-- ② 依頼と申請の結び付けが種類と日付だけで、中身（ot_content）を見ていなかった → 中身が合うときだけ結ぶ（appreq_ot_content_matches）
-- ③ 依頼を受け取った本人が、期限・メモなどを書き換えられた（appreq_update に with check が無い）→ 見張りのトリガー enforce_appreq_transition
--    🚨 止めるのは画面から直接書いたとき（current_user = authenticated）だけ。definer の関数（シフト調整・結び付け）・cron・Edge Function は通す
-- ④ 申請を取り消すと、ほかに合う申請が生きていても依頼が open に戻った／申請を削除すると依頼が applied のまま無い申請を指した
--    → 結び付けの判定 appreq_match_application を1か所にし、取消・削除のときはほかに合う申請へ結び直す（無ければ open）
-- 関数はすべて本番の実定義（2026-10-30）から起こした

-- ── ② 中身の判定（1か所）──────────────────────────────────────────────
-- 依頼の中身（ot_content）と、残業申請の種別（application_types）が合うか。
-- chosei_off／furikae_off／absence＝その種別を含む・time＝終日の3つを含まない・self と空＝何でもよい（今までどおり）
create or replace function public.appreq_ot_content_matches(p_content text, p_types text[])
returns boolean
language sql
immutable
set search_path to 'public'
as $$
  select case coalesce(p_content, '')
    when 'chosei_off'  then coalesce('chosei_off'  = any(p_types), false)
    when 'furikae_off' then coalesce('furikae_off' = any(p_types), false)
    when 'absence'     then coalesce('absence'     = any(p_types), false)
    when 'time'        then not coalesce(p_types && array['chosei_off','furikae_off','absence']::text[], false)
    else true
  end;
$$;
revoke execute on function public.appreq_ot_content_matches(text, text[]) from public;
revoke execute on function public.appreq_ot_content_matches(text, text[]) from anon;

-- ── ④ 結び付けの判定（1か所）：この依頼に合う、生きている申請を1つ返す（p_exclude は除く）──
create or replace function public.appreq_match_application(p_req_id uuid, p_exclude uuid default null)
returns uuid
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  r application_requests%rowtype;
  v_id uuid;
begin
  select * into r from application_requests where id = p_req_id;
  if not found or r.target_dates is null then return null; end if;
  if r.kind = 'overtime' then
    select o.id into v_id
      from overtime_reports o
     where o.applicant_id = r.recipient_id
       and o.entry_type = 'manual'
       and o.status <> 'cancelled'
       and o.work_date = any(r.target_dates)
       and o.id is distinct from p_exclude
       -- 有休からの変更の相談は、その有休を変える申請とだけ（ID で）。ふつうの依頼は、ふつうの申請とだけ
       and o.replaces_leave_id is not distinct from r.replaces_leave_id
       and public.appreq_ot_content_matches(r.ot_content, o.application_types)
     order by o.created_at desc
     limit 1;
  elsif r.kind = 'leave' then
    select l.id into v_id
      from leave_requests l
     where l.user_id = r.recipient_id
       and l.status <> 'cancelled'
       and l.id is distinct from p_exclude
       and exists (
         select 1 from unnest(r.target_dates) as d
          where (case when l.leave_dates is not null and l.leave_dates like '[%' and l.leave_dates <> '[]'
                      then l.leave_dates::jsonb ? to_char(d, 'YYYY-MM-DD')
                      else d between l.start_date and coalesce(l.end_date, l.start_date) end))
     order by l.created_at desc
     limit 1;
  end if;
  return v_id;
end;
$$;
revoke execute on function public.appreq_match_application(uuid, uuid) from public;
revoke execute on function public.appreq_match_application(uuid, uuid) from anon;
revoke execute on function public.appreq_match_application(uuid, uuid) from authenticated;

-- ── ② 申請を出したときの自動の結び付け（本番の実定義から・中身の条件を1行足した）──
CREATE OR REPLACE FUNCTION public.link_application_request_on_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_kind text;
  v_user uuid;
  v_dates date[];
  v_types text[];
begin
  if tg_table_name = 'overtime_reports' then
    if new.entry_type is distinct from 'manual' or new.status = 'cancelled' then return new; end if;
    v_kind := 'overtime';
    v_user := new.applicant_id;
    v_dates := array[new.work_date];
    v_types := new.application_types;
    -- 2026-10-27 段2a：有休からの変更は、その有休の相談だけと結ぶ（ID で）。ふつうの残業の依頼とは結ばない
    if new.replaces_leave_id is not null then
      update application_requests
         set status = 'applied', linked_id = new.id, responded_at = now(), updated_at = now()
       where recipient_id = v_user and kind = 'overtime' and status = 'open'
         and replaces_leave_id = new.replaces_leave_id and target_dates && v_dates;
      return new;
    end if;
  elsif tg_table_name = 'leave_requests' then
    if new.status = 'cancelled' then return new; end if;
    v_kind := 'leave';
    v_user := new.user_id;
    begin
      select coalesce(array_agg(d::date), array[]::date[]) into v_dates
        from jsonb_array_elements_text(new.leave_dates::jsonb) as d;
    exception when others then
      v_dates := array[]::date[];
    end;
    if coalesce(array_length(v_dates, 1), 0) = 0 and new.start_date is not null then
      select array_agg(g::date) into v_dates
        from generate_series(new.start_date, coalesce(new.end_date, new.start_date), interval '1 day') as g;
    end if;
  else
    return new;
  end if;

  if v_user is null or coalesce(array_length(v_dates, 1), 0) = 0 then return new; end if;

  update application_requests
     set status = 'applied', linked_id = new.id, responded_at = now(), updated_at = now()
   where recipient_id = v_user
     and kind = v_kind
     and status = 'open'
     and replaces_leave_id is null   -- 2026-10-27 段2a：有休の種類の変更の相談は、ID で結ぶものだけ
     and target_dates && v_dates
     -- 2026-10-30 段2-0：残業は中身（時間外調整休・振替休日・欠勤・時刻）が合うときだけ結ぶ（時間外調整休の依頼が時刻の申請と結ばれていた）
     and (v_kind <> 'overtime' or public.appreq_ot_content_matches(ot_content, v_types));
  return new;
end;
$function$;

-- ── ④ 申請の取消・削除のとき（本番の実定義から・結び直しと削除を足した）──────────
CREATE OR REPLACE FUNCTION public.reopen_application_request_on_cancel()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r record;
  v_other uuid;
begin
  -- 2026-10-27 段2a：時間外調整休の受理で有休を取り消したときは、有休の元の依頼を open に戻さない
  -- 2026-10-27 段2b：有休の受理で時間外調整休を取り消したときも同じ（両方の表で見る）
  if coalesce(current_setting('app.leave_replaced', true), '') = '1' then
    return coalesce(new, old);
  end if;
  -- 2026-10-30 段2-0：取消（UPDATE で cancelled になった）と削除（DELETE）の両方。
  --   ほかに合う申請が生きていればそちらへ結び直し、無ければ open に戻す（前は必ず open に戻し、削除では何もしなかった）
  if (tg_op = 'UPDATE' and new.status = 'cancelled' and old.status is distinct from 'cancelled') or tg_op = 'DELETE' then
    for r in select id from application_requests where linked_id = old.id and status = 'applied' loop
      v_other := public.appreq_match_application(r.id, old.id);
      if v_other is not null then
        update application_requests set linked_id = v_other, updated_at = now() where id = r.id;
      else
        update application_requests set status = 'open', linked_id = null, updated_at = now() where id = r.id;
      end if;
    end loop;
  end if;
  return coalesce(new, old);
end;
$function$;

drop trigger if exists trg_overtime_delete_reopen_appreq on public.overtime_reports;
create trigger trg_overtime_delete_reopen_appreq after delete on public.overtime_reports
  for each row execute function public.reopen_application_request_on_cancel();
drop trigger if exists trg_leave_delete_reopen_appreq on public.leave_requests;
create trigger trg_leave_delete_reopen_appreq after delete on public.leave_requests
  for each row execute function public.reopen_application_request_on_cancel();

-- ── ③ 依頼の見張り（画面から直接書いたときの、許す動きだけを通す）──────────────
-- 許す動き：受け取った本人の open→applied（自分の同じ種類の申請に結ぶ）／本人の open→dismissed（対応しない）／依頼した人の open→withdrawn（取り下げ）。
-- 中身（期限・メモ・相談した日・時間帯ほか）はあとから変えられない。作るときは open で（結び付け・回答は入れられない）
-- 🚨 security invoker のまま（current_user で「画面から直接」を見分けるため。definer にすると見分けられない）
create or replace function public.enforce_appreq_transition()
returns trigger
language plpgsql
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_admin boolean := coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
begin
  if current_user <> 'authenticated' or v_admin then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if coalesce(new.status, 'open') <> 'open' or new.linked_id is not null or new.responded_at is not null or new.recipient_note is not null then
      raise exception 'APPREQ|依頼は「まだ申請されていない」状態でしか作れません' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.id <> old.id or new.created_at is distinct from old.created_at
     or new.memo is distinct from old.memo or new.due_date is distinct from old.due_date
     or new.consulted_on is distinct from old.consulted_on or new.segments is distinct from old.segments then
    raise exception 'APPREQ|依頼の中身はあとから変えられません。取り下げてから作り直してください' using errcode = 'check_violation';
  end if;
  -- 状態・結び付け・回答が変わらない書き込み（日時だけ）は通す
  if new.status = old.status and new.linked_id is not distinct from old.linked_id
     and new.recipient_note is not distinct from old.recipient_note then
    return new;
  end if;
  if old.status = 'open' and new.status = 'applied' and v_uid = old.recipient_id and new.linked_id is not null
     and new.recipient_note is not distinct from old.recipient_note
     and ((old.kind = 'overtime' and exists (select 1 from overtime_reports o where o.id = new.linked_id and o.applicant_id = v_uid and o.status <> 'cancelled'))
       or (old.kind = 'leave' and exists (select 1 from leave_requests l where l.id = new.linked_id and l.user_id = v_uid and l.status <> 'cancelled'))) then
    return new;
  end if;
  if old.status = 'open' and new.status = 'dismissed' and v_uid = old.recipient_id and new.linked_id is null then
    return new;
  end if;
  if old.status = 'open' and new.status = 'withdrawn' and v_uid = old.requester_id and new.linked_id is null
     and new.recipient_note is not distinct from old.recipient_note then
    return new;
  end if;
  raise exception 'APPREQ|この依頼の状態は変えられません（すでに処理された可能性があります）' using errcode = 'check_violation';
end;
$$;
revoke execute on function public.enforce_appreq_transition() from public;
revoke execute on function public.enforce_appreq_transition() from anon;

drop trigger if exists trg_appreq_guard on public.application_requests;
create trigger trg_appreq_guard before insert or update on public.application_requests
  for each row execute function public.enforce_appreq_transition();
