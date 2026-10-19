-- 休暇申請と残業申請の終日の休みが、同じ日に重ならないようにする（2026-10-19 ユーザー確定・文は案1）
-- きっかけ：10/31（有休奨励日）に、奨励日の回答の有休（休暇申請）と、残業申請の時間外調整休が両方出ていた。
--   休暇申請と残業申請は別の表で、重なりを確かめる所が DB にも画面にも無かった
-- ・止める：休暇申請（取消・差し戻し以外）がある日に、残業申請の終日の休み（時間外調整休・振替休日・欠勤）を出す／その反対
-- ・奨励日の回答も同じ（回答で作られる休暇申請が止まる＝回答も保存されない）
-- ・数えないもの：取消・差し戻し（休暇は cancelled／rejected、残業は cancelled／rejected／returned）。
--   休暇の調整休から自動で作られる残業の記録（entry_type='leave_auto'）は同じ休みの写しなので数えない
-- ・文は day_off_conflict_message 1か所（トリガーと、送る前の確かめ my_day_off_conflict が同じものを使う）
-- ・止めたときは 'DAYOFF_CONFLICT|<文>' で投げる。画面は「|」のあとをそのまま出す
-- 🚨 今ある重なり（2件）は触らない（新しく出す・出し直すときだけ止める）

begin;

-- 曜日つきの日付（10/31（土））
create or replace function public.jp_md_dow(d date)
returns text language sql immutable set search_path = public as $$
  select extract(month from d)::int || '/' || extract(day from d)::int || '（' ||
         (array['日','月','火','水','木','金','土'])[extract(dow from d)::int + 1] || '）';
$$;

-- 休暇の種類の呼び名
create or replace function public.day_off_leave_label(p_leave_type text)
returns text language sql immutable set search_path = public as $$
  select case p_leave_type
    when '有給休暇' then '有休'
    when 'バースデー休暇（有給）' then '有休'
    when '調整休' then '調整休'
    when '慶弔休暇' then '慶弔休暇'
    else 'その他' end;
$$;

-- 残業申請の終日の休みの呼び名
create or replace function public.day_off_ot_label(p_types text[])
returns text language sql immutable set search_path = public as $$
  select case
    when p_types @> array['chosei_off'] then '時間外調整休'
    when p_types @> array['furikae_off'] then '振替休日'
    when p_types @> array['ot_absence'] then '欠勤'
    else null end;
$$;

-- 重なりの文（無ければ null）。p_side：'overtime'＝これから残業申請の終日の休みを出す／'leave'＝これから休暇申請（奨励日の回答を含む）を出す
-- p_new ＝ これから出すものの呼び名（例：時間外調整休・休暇申請（有休）・有休奨励日の休み（有休））
-- p_verb ＝ '申請' か '回答'
create or replace function public.day_off_conflict_message(p_user uuid, p_date date, p_side text, p_new text, p_verb text)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  v_existing text;
begin
  if p_side = 'overtime' then
    select '休暇申請（' || public.day_off_leave_label(l.leave_type) || '）' into v_existing
      from leave_requests l
     where l.user_id = p_user and l.status not in ('cancelled', 'rejected')
       and l.leave_dates is not null and l.leave_dates::jsonb ? p_date::text
     order by l.created_at limit 1;
  else
    select '残業申請（' || public.day_off_ot_label(o.application_types) || '）' into v_existing
      from overtime_reports o
     where o.applicant_id = p_user and o.work_date = p_date and o.entry_type = 'manual'
       and o.status not in ('cancelled', 'rejected', 'returned')
       and o.application_types && array['chosei_off', 'furikae_off', 'ot_absence']
     order by o.created_at limit 1;
  end if;
  if v_existing is null then return null; end if;
  return public.jp_md_dow(p_date) || 'はすでに' || v_existing || 'が出ています。同じ日に' || p_new || 'は' || p_verb ||
         'できません。内容を変えるときは、先に出ている申請を「📩 修正依頼」から取消・修正してください。';
end;
$$;

-- 送る前の確かめ（本人だけ）。最初に見つかった重なりの文（無ければ null）
-- p_side='overtime'：p_kind＝残業申請の種類（chosei_off／furikae_off／ot_absence）
-- p_side='leave'   ：p_kind＝休暇の種類（有給休暇・調整休 など）。p_encouragement＝有休奨励日の回答か
-- 🚨 呼び名はここ（DB）で付ける。画面に同じ表を書かない（トリガーと同じ呼び名になる）
create or replace function public.my_day_off_conflict(p_dates date[], p_side text, p_kind text, p_encouragement boolean default false)
returns text language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  d date;
  v_msg text;
  v_new text;
  v_verb text;
begin
  if v_uid is null or p_side not in ('overtime', 'leave') then return null; end if;
  if p_side = 'overtime' then
    v_new := public.day_off_ot_label(array[p_kind]); v_verb := '申請';
    if v_new is null then return null; end if;
  elsif p_encouragement then
    v_new := '有休奨励日の休み（' || public.day_off_leave_label(p_kind) || '）'; v_verb := '回答';
  else
    v_new := '休暇申請（' || public.day_off_leave_label(p_kind) || '）'; v_verb := '申請';
  end if;
  foreach d in array coalesce(p_dates, '{}') loop
    v_msg := public.day_off_conflict_message(v_uid, d, p_side, v_new, v_verb);
    if v_msg is not null then return v_msg; end if;
  end loop;
  return null;
end;
$$;

-- 残業申請：終日の休みを出す（出し直す・日付や種類を変える）とき
create or replace function public.enforce_day_off_conflict_overtime()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_label text;
  v_msg text;
begin
  if new.entry_type is distinct from 'manual' then return new; end if;
  if new.status in ('cancelled', 'rejected', 'returned') then return new; end if;
  v_label := public.day_off_ot_label(new.application_types);
  if v_label is null then return new; end if;
  if tg_op = 'UPDATE'
     and old.status not in ('cancelled', 'rejected', 'returned')
     and old.work_date = new.work_date
     and old.application_types is not distinct from new.application_types then
    return new;
  end if;
  v_msg := public.day_off_conflict_message(new.applicant_id, new.work_date, 'overtime', v_label, '申請');
  if v_msg is not null then raise exception 'DAYOFF_CONFLICT|%', v_msg; end if;
  return new;
end;
$$;

drop trigger if exists trg_day_off_conflict_overtime on public.overtime_reports;
create trigger trg_day_off_conflict_overtime
  before insert or update of status, work_date, application_types, entry_type on public.overtime_reports
  for each row execute function public.enforce_day_off_conflict_overtime();

-- 休暇申請（奨励日の回答を含む）を出す（出し直す・日付を変える）とき
create or replace function public.enforce_day_off_conflict_leave()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_new text;
  v_verb text;
  v_msg text;
  d text;
begin
  if new.status in ('cancelled', 'rejected') then return new; end if;
  if new.leave_dates is null then return new; end if;
  if tg_op = 'UPDATE'
     and old.status not in ('cancelled', 'rejected')
     and old.leave_dates is not distinct from new.leave_dates then
    return new;
  end if;
  if coalesce(new.reason, '') = '【有給奨励日】' then
    v_new := '有休奨励日の休み（' || public.day_off_leave_label(new.leave_type) || '）';
    v_verb := '回答';
  else
    v_new := '休暇申請（' || public.day_off_leave_label(new.leave_type) || '）';
    v_verb := '申請';
  end if;
  for d in select jsonb_array_elements_text(new.leave_dates::jsonb) loop
    v_msg := public.day_off_conflict_message(new.user_id, d::date, 'leave', v_new, v_verb);
    if v_msg is not null then raise exception 'DAYOFF_CONFLICT|%', v_msg; end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_day_off_conflict_leave on public.leave_requests;
create trigger trg_day_off_conflict_leave
  before insert or update of status, leave_dates on public.leave_requests
  for each row execute function public.enforce_day_off_conflict_leave();

-- 権限：送る前の確かめだけ画面から呼べる。ほかは中で使うだけ
revoke execute on function public.day_off_conflict_message(uuid, date, text, text, text) from public;
revoke execute on function public.day_off_conflict_message(uuid, date, text, text, text) from anon;
revoke execute on function public.day_off_conflict_message(uuid, date, text, text, text) from authenticated;
revoke execute on function public.my_day_off_conflict(date[], text, text, boolean) from public;
revoke execute on function public.my_day_off_conflict(date[], text, text, boolean) from anon;
grant execute on function public.my_day_off_conflict(date[], text, text, boolean) to authenticated;
grant execute on function public.my_day_off_conflict(date[], text, text, boolean) to retiree;
revoke execute on function public.jp_md_dow(date) from public, anon;
revoke execute on function public.day_off_leave_label(text) from public, anon;
revoke execute on function public.day_off_ot_label(text[]) from public, anon;
revoke execute on function public.enforce_day_off_conflict_overtime() from public, anon, authenticated;
revoke execute on function public.enforce_day_off_conflict_leave() from public, anon, authenticated;

commit;
