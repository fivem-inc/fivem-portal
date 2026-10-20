-- ============================================================
-- 2026-10-20  休暇申請と残業申請の「欠勤」が同じ日に重なっても止まっていなかった（取り違えの直し）
-- ============================================================
-- 20261019123153_day_off_conflict で、残業申請の欠勤を 'ot_absence' で探していた。本当の値は 'absence'（'ot_absence' はシフト調整のきっかけの名前）。
-- そのため ① 休暇を出すとき、同じ日の残業申請の欠勤が見つからない ② 残業申請で欠勤を出すとき、day_off_ot_label が null を返して確かめを飛ばしていた（画面の事前の確かめも同じ）。
-- 時間外調整休・振替休日の重なりは前から止まっている。本番の実定義（2026-10-20）から、2つの関数の1か所ずつだけ直した。
-- ロールバック手順：作業用フォルダ（D ドライブの fivem-work の rollback-20261020-encouragement）に控えた def_ota_day_off_ot_label.sql・def_ota_day_off_conflict_message.sql で作り直す

CREATE OR REPLACE FUNCTION public.day_off_ot_label(p_types text[])
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public'
AS $function$
  select case
    when p_types @> array['chosei_off'] then '時間外調整休'
    when p_types @> array['furikae_off'] then '振替休日'
    -- 2026-10-20：残業申請の欠勤の値は 'absence'（lib/overtimeTypes）。前は 'ot_absence'（シフト調整のきっかけの名前）と取り違えて null になり、欠勤の重なりが止まっていなかった
    when p_types @> array['absence'] or p_types @> array['ot_absence'] then '欠勤'
    else null end;
$function$;

CREATE OR REPLACE FUNCTION public.day_off_conflict_message(p_user uuid, p_date date, p_side text, p_new text, p_verb text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
       and o.application_types && array['chosei_off', 'furikae_off', 'absence']   -- 2026-10-20：'ot_absence' は取り違え（本当の値は absence）
     order by o.created_at limit 1;
  end if;
  if v_existing is null then return null; end if;
  return public.jp_md_dow(p_date) || 'はすでに' || v_existing || 'が出ています。同じ日に' || p_new || 'は' || p_verb ||
         'できません。内容を変えるときは、先に出ている申請を「📩 修正依頼」から取消・修正してください。';
end;
$function$;
