-- 時間外調整休（休暇申請）から作る残業のマイナス行：登録シフトの探し方を registered_shift_of 1か所にそろえる（2026-10-27・引き継ぎ (339) の残り）
-- 🚨 本番の実定義（2026-10-27 に pg_get_functiondef で取得）から起こした。変えたのは登録シフトを探す2つの select を registered_shift_of にしただけ。
--    控え（normal_shift）の day_kind は、見つかった行の day_kind（「出」の行が無く曜日の行を使ったときは曜日＝今までと同じ）
-- ・動きは変えていない：本番で 45人 × 2026-04-01〜2027-03-31（16,425とおり）で、今までの探し方と registered_shift_of の見つける行の違いが0件
-- ・戻すとき：20260926144017_sync_overtime_from_leave_work_on_closed_fallback.sql に 20261020160206 の INSERT・変更の扱いを足した版（下の本体の select 2つを元に戻す）

create or replace function public.sync_overtime_from_leave()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  d date;
  v_kind text;
  v_day_kind text;
  v_pattern weekly_shift_patterns%rowtype;
  v_period_start date;
  v_old_status text;              -- INSERT のときは null
  v_changed boolean := false;     -- 受理済みのまま種類・印・日付が変わった
begin
  -- 2026-10-20：INSERT（受理済みで作られた休暇＝奨励日の回答）でも動く。INSERT のとき old は無いので、ここで分けて持つ
  if tg_op = 'UPDATE' then
    v_old_status := old.status;
    v_changed := old.leave_type is distinct from new.leave_type
              or old.chosei_sub_type is distinct from new.chosei_sub_type
              or old.leave_dates is distinct from new.leave_dates;
  end if;

  -- ① 受理が取り消されたら、自動で作ったマイナス行を消す（07-24 版にあり、08-06 で抜けていた）
  --    2026-10-20：受理済みのまま種類・印・日付が変わったときも消す（このあと ② で今の中身から作り直す）
  if v_old_status = 'approved' and (new.status is distinct from 'approved' or v_changed) then
    delete from overtime_reports
    where source_leave_request_id = new.id and entry_type = 'leave_auto';
  end if;

  -- ② 受理になった瞬間の時間外調整休：日ごとにマイナス行を作る
  if new.status = 'approved' and (v_old_status is distinct from 'approved' or v_changed)
     and new.leave_type = '調整休' and new.chosei_sub_type = 'zangyou' then

    -- 何度動いても二重にならないよう、先に消してから作り直す
    delete from overtime_reports
    where source_leave_request_id = new.id and entry_type = 'leave_auto';

    for d in
      select (jsonb_array_elements_text(new.leave_dates::jsonb))::date
    loop
      -- 控えに残す会社カレンダーの種類
      select kind into v_kind from company_calendar where date = d;

      -- 登録シフト（その日に有効な行だけ・会社カレンダー優先・「出」の行が無ければ曜日の行）。
      -- 🚨 探し方は registered_shift_of 1か所（出張の照合・overtime_confirm_trip_rostered と同じ・2026-10-27 にそろえた）
      v_pattern := public.registered_shift_of(new.user_id, d);
      v_day_kind := v_pattern.day_kind;

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
$$;
