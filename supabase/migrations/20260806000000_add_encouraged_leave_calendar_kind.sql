-- 会社カレンダーに「休館日・社員出勤日（有休奨励日）」を追加する。
--
-- 紙の全社年間カレンダーが3色（ピンク＝全社員休み／黄＝社員出勤日／緑＝有休奨励日）で
-- 運用されているため、画面の選択肢を紙と1対1にして入力ミスを防ぐ。
--
-- 残業の計算では work_on_closed（社員出勤日）と同じ扱い＝所定労働日。
-- 違うのはカレンダー上の色だけ。
--
-- ⚠️ この種別は「カレンダーの色と残業計算」のためのもので、
--    スタッフに回答を求める有給奨励日（paid_leave_encouragement_days）とは別物。
--    回答を求める場合は、従来どおり 管理画面 → 休暇申請 → 有給奨励日 から作成する。

alter table company_calendar drop constraint if exists company_calendar_kind_check;

alter table company_calendar
  add constraint company_calendar_kind_check
  check (kind in ('closed_all', 'work_on_closed', 'work_on_closed_encouraged'));

-- 🚨 曜日の解決は「クライアント(breakCalc.resolveDayKind)」と「このトリガー」の2か所にある。
-- 片方だけ直すと、有休奨励日に調整休を取ったとき残業の相殺が効かなくなるので必ず同時に直す。
-- 変更点は elsif の1行だけ（有休奨励日を出勤日と同じ扱いにする）。他の処理は 20260724000000 のまま。
create or replace function sync_overtime_from_leave() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  d date;
  v_kind text;
  v_day_kind text;
  v_pattern weekly_shift_patterns%rowtype;
  v_period_start date;
begin
  if new.leave_type = '調整休' and new.chosei_sub_type = 'zangyou' and new.status = 'approved' then
    delete from overtime_reports
    where source_leave_request_id = new.id and entry_type = 'leave_auto';

    for d in
      select (jsonb_array_elements_text(new.leave_dates::jsonb))::date
    loop
      -- 会社カレンダー優先で day_kind を解決
      select kind into v_kind from company_calendar where date = d;
      if v_kind = 'closed_all' then
        v_day_kind := 'holiday';
      elsif v_kind in ('work_on_closed', 'work_on_closed_encouraged') then
        v_day_kind := 'work_on_closed';
      else
        v_day_kind := (array['sun','mon','tue','wed','thu','fri','sat'])[extract(dow from d)::int + 1];
      end if;

      select * into v_pattern from weekly_shift_patterns
      where user_id = new.user_id
        and day_kind = v_day_kind
        and valid_from <= d
        and (valid_to is null or valid_to >= d)
      order by valid_from desc
      limit 1;

      if v_pattern.id is not null and coalesce(v_pattern.labor_minutes, 0) > 0 then
        v_period_start := calc_pay_period_start(d);
        insert into overtime_reports (
          user_id, work_date, pay_period_start, entry_type, status,
          normal_shift, break_minutes, labor_minutes, diff_minutes,
          reason, source_leave_request_id, confirmed_at
        ) values (
          new.user_id, d, v_period_start, 'leave_auto', 'confirmed',
          jsonb_build_object(
            'day_kind', v_day_kind,
            'calendar_kind', v_kind,
            'start_time', v_pattern.start_time,
            'end_time', v_pattern.end_time,
            'break_minutes', v_pattern.break_minutes,
            'labor_minutes', v_pattern.labor_minutes
          ),
          0, 0, -v_pattern.labor_minutes,
          '時間外調整休（休暇申請より自動計上）', new.id, now()
        );
      end if;
    end loop;
  end if;
  return new;
end;
$$;
