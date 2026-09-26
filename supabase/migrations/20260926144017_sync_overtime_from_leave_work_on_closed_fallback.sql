-- ============================================================
-- 2026-09-26  「休館日・社員出勤日」に「出」の行が無い人は、その日の曜日の行を通常シフトにする
-- ============================================================
-- ✅ ユーザー確定（2026-09-26）：休館日・社員出勤日の勤務時間はいつもの曜日と同じ。
--    「出（休館日だけど出勤日）」の行に入れてある人だけ、そちらを優先する。
--
-- 症状：10/29（大掃除・会社カレンダー work_on_closed）の残業申請で、通常シフトが「休み」になり
--       働いた 7:45 が丸ごと「休日出勤 +7:45」になった（森本さん。正しくは木曜 5:45 との差 +2:00）。
--       勤務パターンの「出」の行は 43人全員が空（2026-09-26 実測）。
-- 🚨 画面側（lib/overtimeShift.ts resolveNormalShift）にも同じ判定を入れた。片方だけ直さないこと。
-- 🚨 本番の実定義（pg_get_functiondef・2026-09-26）から起こし、変えたのは「『出』が無ければ曜日の行をもう一度引く」の1か所だけ。

create or replace function public.sync_overtime_from_leave()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  d date;
  v_kind text;
  v_day_kind text;
  v_pattern weekly_shift_patterns%rowtype;
  v_period_start date;
begin
  -- ① 受理が取り消されたら、自動で作ったマイナス行を消す（07-24 版にあり、08-06 で抜けていた）
  if old.status = 'approved' and new.status is distinct from 'approved' then
    delete from overtime_reports
    where source_leave_request_id = new.id and entry_type = 'leave_auto';
  end if;

  -- ② 受理になった瞬間の時間外調整休：日ごとにマイナス行を作る
  if new.status = 'approved' and old.status is distinct from 'approved'
     and new.leave_type = '調整休' and new.chosei_sub_type = 'zangyou' then

    -- 何度動いても二重にならないよう、先に消してから作り直す
    delete from overtime_reports
    where source_leave_request_id = new.id and entry_type = 'leave_auto';

    for d in
      select (jsonb_array_elements_text(new.leave_dates::jsonb))::date
    loop
      -- 会社カレンダー優先で day_kind を解決（08-06 の改善を残す）
      select kind into v_kind from company_calendar where date = d;
      if v_kind = 'closed_all' then
        v_day_kind := 'holiday';
      elsif v_kind in ('work_on_closed', 'work_on_closed_encouraged') then
        v_day_kind := 'work_on_closed';
      else
        v_day_kind := (array['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from d)::int + 1];
      end if;

      -- 🚨 weekly_shift_patterns の列は user_id で正しい（overtime_reports とは列名が違う）
      select * into v_pattern from weekly_shift_patterns
      where user_id = new.user_id
        and day_kind = v_day_kind
        and valid_from <= d
        and (valid_to is null or valid_to >= d)
      order by valid_from desc
      limit 1;

      -- 🚨 「休館日・社員出勤日」で「出」の行が無い人は、その日の曜日の行を使う（2026-09-26 ユーザー確定）。
      --    画面側 resolveNormalShift と同じ判定。「出」に入れてある人はそちらが優先
      if v_pattern.id is null and v_day_kind = 'work_on_closed' then
        v_day_kind := (array['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from d)::int + 1];
        select * into v_pattern from weekly_shift_patterns
        where user_id = new.user_id
          and day_kind = v_day_kind
          and valid_from <= d
          and (valid_to is null or valid_to >= d)
        order by valid_from desc
        limit 1;
      end if;

      -- その日に通常シフトがある場合のみマイナス計上（休みの日の調整休は0のため対象外）
      if v_pattern.id is not null and coalesce(v_pattern.labor_minutes, 0) > 0 then
        v_period_start := calc_pay_period_start(d);
        insert into overtime_reports (
          applicant_id, submitted_by, work_date, pay_period_start,
          entry_type, status,
          normal_shift, break_minutes, break_manual, labor_minutes, diff_minutes,
          reason, confirmed_by, confirmed_at, source_leave_request_id
        ) values (
          new.user_id, new.user_id, d, v_period_start,
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
          coalesce(auth.uid(), new.approver_id), now(), new.id
        );
      end if;
    end loop;
  end if;

  return new;
end;
$function$;

-- 確認用:
--   select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'sync_overtime_from_leave';   -- 「出」が無ければ曜日 の枝があること
