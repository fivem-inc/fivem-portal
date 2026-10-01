-- 振替休日の二重計上を止めるトリガーの穴を2つふさぐ（2026-10-01 ユーザー承認）
--
-- 🚨 本番の実定義（pg_get_functiondef・2026-10-01 取得）から起こした。既存の2つの判定はそのまま残し、足しただけ。
--
-- これまで止まらなかったもの：
--   穴①：同じ振替元の日を、2つの振替休日に使う（10/5 も 10/6 も振替元が 9/27）
--         … 振替元の日に「勤務日が同じ申請」があるかしか見ておらず、「振替元が同じ振替休日」を見ていなかった
--   穴②：振替休日にした日を、先に出した別の振替休日の振替元として使われている日にする
--         … 「この日を振替元にしている振替休日があるか」は振替休日以外の申請にしか当てていなかった
-- 2026-10-01 時点の本番：振替休日は1件・穴①②に当たる組は0件（適用しても既存の申請は止まらない）
--
-- 画面の文言：穴② は既存の FURIKAE_DUP_WORKDATE と同じ（friendlyOvertimeDbError がそのまま日本語にする）。
--             穴① は新しい FURIKAE_DUP_SAME_ORIGIN（lib/overtimeSubmit の friendlyOvertimeDbError に1行足す）

create or replace function public.enforce_furikae_no_double_count()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_is_furikae boolean := ('furikae_off' = any(coalesce(new.application_types, '{}')));
  v_hit int;
begin
  -- 取消行は対象外
  if new.status = 'cancelled' or new.entry_type <> 'manual' then
    return new;
  end if;

  if v_is_furikae and new.furikae_origin_date is not null then
    -- 振替休日：振替元日に別の非cancelled manual行があればブロック
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

    -- 穴①（2026-10-01）：同じ振替元の日を使っている、別の非cancelledの振替休日があればブロック
    select count(*) into v_hit
    from overtime_reports r
    where r.applicant_id = new.applicant_id
      and r.entry_type = 'manual'
      and r.status <> 'cancelled'
      and r.id <> new.id
      and ('furikae_off' = any(coalesce(r.application_types, '{}')))
      and r.furikae_origin_date = new.furikae_origin_date;
    if v_hit > 0 then
      raise exception 'FURIKAE_DUP_SAME_ORIGIN: 振替元の日（%）は、すでに別の振替休日の振替元になっています。同じ日を2回振り替えることはできません。', to_char(new.furikae_origin_date, 'YYYY/MM/DD')
        using errcode = 'check_violation';
    end if;
  end if;

  -- すべての manual 行（🚨 2026-10-01 から振替休日にも当てる＝穴②）：
  -- この日を振替元にしている非cancelledの振替休日があればブロック
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

  return new;
end;
$function$;
