-- ============================================================
-- 2026-10-20  有休奨励日の「調整休」を残業の時間から引く（ユーザー確定）
-- ============================================================
-- きっかけ：奨励日の回答で「調整休」を選んでも、休暇の行に時間外調整休の印（chosei_sub_type='zangyou'）が無く、
--   しかも受理済みで作るので「受理になった瞬間」に動くトリガーも動かず、残業の時間から1分も引かれていなかった（全員で15件）。
--   今の期の 10/31 の3件は、合計時間数・残業の目安超え（例：見込み＋7:15→本当は−0:45）に効いている。
-- 直すこと（関数はすべて 2026-10-20 の本番の実定義から起こし、必要な行だけ足した）：
--   ① enforce_leave_adjust_moved：10/16 からの「調整休は残業申請で」の止めを、奨励日の回答（app.enc_answer）からだけ通す
--   ② sync_overtime_from_leave：INSERT（受理済みで作る）でも、受理済みのまま種類・印・日付が変わったときも、マイナス行を作り直す
--      ＋トリガー：UPDATE の条件に leave_type・chosei_sub_type・leave_dates の変化を足す／INSERT のトリガーを足す
--   ③ answer_encouragement_day・admin_set_encouragement_answer：調整休に 'zangyou' の印
--   ④ 今の期（2026-10-16〜）の奨励日の調整休に印を付ける（→ ② でマイナス行ができる）。🚨 7/29・8/16 の12件は触らない（給与で手計算済み・ユーザー確認）
--
-- ロールバック手順：
--   この migration の前の定義は、2026-10-20 の本番の実定義（pg_get_functiondef）を D:\fivem-work に控えた版で戻す。
--   トリガー：drop trigger leave_requests_sync_overtime_ins on leave_requests;
--             drop trigger leave_requests_sync_overtime on leave_requests;
--             create trigger leave_requests_sync_overtime after update on public.leave_requests for each row
--               when (old.status is distinct from new.status) execute function sync_overtime_from_leave();
--   ④ で作ったマイナス行：delete from overtime_reports o using leave_requests l
--     where o.source_leave_request_id = l.id and o.entry_type = 'leave_auto' and l.reason = '【有給奨励日】';
--     update leave_requests set chosei_sub_type = null where reason = '【有給奨励日】' and leave_type = '調整休' and start_date >= '2026-10-16';

-- ① 止め
CREATE OR REPLACE FUNCTION public.enforce_leave_adjust_moved()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_cut date := public.overtime_unify_cutoff();
begin
  if v_cut is null then return new; end if;
  if new.leave_type is distinct from '調整休' or new.chosei_sub_type is null then return new; end if;
  if coalesce(new.purpose, '') = '残業調整（提案受諾）' then return new; end if;
  -- 2026-10-20 奨励日の回答から作る調整休（時間外調整休の印つき）は通す。🚨 理由欄の文字では通さない（本人が書ける）。
  --   印 app.enc_answer は answer_encouragement_day／admin_set_encouragement_answer の中だけで立つ
  if coalesce(current_setting('app.enc_answer', true), '') = '1' then return new; end if;
  if coalesce(new.status, '') in ('cancelled', 'rejected', 'withdrawn') then return new; end if;
  if exists (select 1 from unnest(public.shift_adjust_days(new.leave_dates, new.start_date, new.end_date)) d where d >= v_cut) then
    raise exception 'LEAVE_ADJUST_MOVED: %以降の調整休（時間外調整休・振替休日）は「残業申請」で申請してください', to_char(v_cut, 'FMMM/FMDD')
      using errcode = 'check_violation';
  end if;
  return new;
end;
$function$;

-- ② 台帳
CREATE OR REPLACE FUNCTION public.sync_overtime_from_leave()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

drop trigger if exists leave_requests_sync_overtime on public.leave_requests;
create trigger leave_requests_sync_overtime
  after update on public.leave_requests
  for each row
  when (old.status is distinct from new.status
        or old.leave_type is distinct from new.leave_type
        or old.chosei_sub_type is distinct from new.chosei_sub_type
        or old.leave_dates is distinct from new.leave_dates)
  execute function public.sync_overtime_from_leave();

drop trigger if exists leave_requests_sync_overtime_ins on public.leave_requests;
create trigger leave_requests_sync_overtime_ins
  after insert on public.leave_requests
  for each row
  when (new.status = 'approved' and new.leave_type = '調整休' and new.chosei_sub_type = 'zangyou')
  execute function public.sync_overtime_from_leave();

-- ③ 奨励日の回答
CREATE OR REPLACE FUNCTION public.answer_encouragement_day(p_day_id uuid, p_choice integer, p_note text DEFAULT NULL::text, p_working boolean DEFAULT false)
 RETURNS TABLE(ok boolean, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid          uuid := auth.uid();
  v_target_date  date;
  v_note         text := nullif(btrim(coalesce(p_note, '')), '');
  v_leave_type   text;
  v_type_other   text;
  v_inserted     integer;
begin
  if v_uid is null then
    return query select false, 'ログインが必要です'::text; return;
  end if;
  if p_choice is null or p_choice not in (1, 2, 3, 4, 5) then
    return query select false, '回答を選んでください'::text; return;
  end if;
  if p_choice in (4, 5) and v_note is null then
    return query select false, (case when p_choice = 4 then '「出勤する」を選んだときは内容を書いてください' else '「ほかの休みを申請する」を選んだときは内容を書いてください' end)::text; return;
  end if;

  -- その日の対象者か（画面の出し分けに頼らず、ここで確かめる）
  select d.target_date into v_target_date
  from paid_leave_encouragement_days d
  join paid_leave_encouragement_targets t
    on t.encouragement_day_id = d.id and t.user_id = v_uid
  where d.id = p_day_id;

  if v_target_date is null then
    return query select false, 'この有休奨励日の対象ではありません'::text; return;
  end if;

  -- 2026-10-19 奨励日：作る休暇の中身（出勤・ほかの休みは作らない）
  select s.leave_type, s.leave_type_other into v_leave_type, v_type_other
  from public.encouragement_leave_spec(p_choice, v_note, p_working) s;

  -- 2026-10-19 奨励日：その日にほかの休暇がもうあれば、休暇を作る回答は断る（休暇が2件になるのを防ぐ）
  if v_leave_type is not null and exists (
    select 1 from leave_requests lr
    where lr.user_id = v_uid
      and lr.status not in ('cancelled', 'rejected')
      and coalesce(lr.reason, '') <> '【有給奨励日】'
      and lr.leave_dates is not null
      and lr.leave_dates::jsonb ? to_char(v_target_date, 'YYYY-MM-DD')
  ) then
    return query select false, (public.jp_md_dow(v_target_date) || 'にはすでに休暇申請が出ています。経理へご相談ください。')::text; return;
  end if;

  -- 回答（同じ奨励日・同じ人は1件だけ。2回目はここで止める）
  insert into paid_leave_encouragement_responses (encouragement_day_id, user_id, choice, note, working)
  values (p_day_id, v_uid, p_choice, v_note, case when p_choice = 4 then coalesce(p_working, false) else null end)
  on conflict (encouragement_day_id, user_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return query select false, 'すでに回答済みです'::text; return;
  end if;

  if v_leave_type is not null then
    -- 2026-10-19 奨励日：奨励日の止めを通す印（この関数の中だけ）
    perform set_config('app.enc_answer', '1', true);
    -- 何度動いても二重にならないよう、同じ人・同じ日・奨励日由来の行が無いときだけ作る
    -- 🚨 表の別名（lr）を必ず付ける。`reason` は**戻り値の名前でもある**ので、裸で書くと
    --    「どちらの reason か分からない」で落ちる（42702）。場所予約の繰り上げで同じ形を踏んでいる
    if not exists (
      select 1 from leave_requests lr
      where lr.user_id = v_uid and lr.start_date = v_target_date and lr.reason = '【有給奨励日】'
    ) then
      -- 2026-10-20：調整休は「時間外調整休」の印（chosei_sub_type='zangyou'）を付ける。付けないと残業の時間から引かれない
      --   （受理済みで作るので、台帳のマイナス行は leave_requests の INSERT のトリガー sync_overtime_from_leave が作る）
      insert into leave_requests (
        user_id, leave_type, leave_type_other, chosei_sub_type, leave_dates, start_date, end_date,
        purpose, reason, status, current_approver
      ) values (
        v_uid, v_leave_type, v_type_other, case when v_leave_type = '調整休' then 'zangyou' end,
        to_json(array[to_char(v_target_date, 'YYYY-MM-DD')])::text,
        v_target_date, v_target_date,
        '有給奨励日', '【有給奨励日】', 'approved', 'none'
      );
    end if;
    perform set_config('app.enc_answer', '', true);
  end if;

  return query select true, null::text;
end;
$function$;

CREATE OR REPLACE FUNCTION public.admin_set_encouragement_answer(p_day_id uuid, p_user_id uuid, p_choice integer, p_note text DEFAULT NULL::text, p_working boolean DEFAULT false)
 RETURNS TABLE(ok boolean, reason text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_target_date date;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_leave_type text;
  v_type_other text;
begin
  if not public.is_admin() then
    return query select false, '管理者だけが直せます'::text; return;
  end if;
  if p_choice is null or p_choice not in (1, 2, 3, 4, 5) then
    return query select false, '回答を選んでください'::text; return;
  end if;
  if p_choice in (4, 5) and v_note is null then
    return query select false, '内容を書いてください'::text; return;
  end if;
  select d.target_date into v_target_date from paid_leave_encouragement_days d where d.id = p_day_id;
  if v_target_date is null then
    return query select false, '有休奨励日が見つかりません'::text; return;
  end if;

  select s.leave_type, s.leave_type_other into v_leave_type, v_type_other
  from public.encouragement_leave_spec(p_choice, v_note, p_working) s;

  insert into paid_leave_encouragement_responses (encouragement_day_id, user_id, choice, note, working)
  values (p_day_id, p_user_id, p_choice, v_note, case when p_choice = 4 then coalesce(p_working, false) else null end)
  on conflict (encouragement_day_id, user_id) do update
    set choice = excluded.choice, note = excluded.note, working = excluded.working;

  perform set_config('app.enc_answer', '1', true);
  delete from leave_requests lr
  where lr.user_id = p_user_id and lr.start_date = v_target_date
    and lr.reason = '【有給奨励日】' and lr.status = 'approved';
  if v_leave_type is not null then
    -- 2026-10-20：調整休は「時間外調整休」の印（answer_encouragement_day と同じ）
    insert into leave_requests (
      user_id, leave_type, leave_type_other, chosei_sub_type, leave_dates, start_date, end_date,
      purpose, reason, status, current_approver
    ) values (
      p_user_id, v_leave_type, v_type_other, case when v_leave_type = '調整休' then 'zangyou' end,
      to_json(array[to_char(v_target_date, 'YYYY-MM-DD')])::text,
      v_target_date, v_target_date,
      '有給奨励日', '【有給奨励日】', 'approved', 'none'
    );
  end if;
  perform set_config('app.enc_answer', '', true);

  return query select true, null::text;
end;
$function$;

-- ④ 今の期の奨励日の調整休に印を付ける（② の UPDATE のトリガーでマイナス行ができる）
select set_config('app.enc_answer', '1', true);
update public.leave_requests lr
   set chosei_sub_type = 'zangyou'
 where lr.reason = '【有給奨励日】' and lr.leave_type = '調整休' and lr.chosei_sub_type is null
   and lr.status = 'approved' and lr.start_date >= date '2026-10-16';
select set_config('app.enc_answer', '', true);
