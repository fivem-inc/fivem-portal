-- 「有休奨励日」に言葉をそろえる（2026-10-06 ユーザー確定「有休奨励日　これで統一」）
-- 🚨 保存されている目印は変えない：休暇の reason='【有給奨励日】'・purpose='有給奨励日'（69件）。
--    answer_encouragement_day（下）と shift_adjust_recompute がこの文字で判定している。画面は lib/encouragementDay.ts で言い換える
-- 🚨 すでに送った通知（35件）は直さない（過去の記録）。画面は昔の書き方も見分ける
-- 直すのは：回答の関数のお断り文1つ・社内FAQ（答え2件・トピック1件）・メール通知の件名と本文（1件）

begin;

-- 1. 回答の関数：お断り文だけ（本番の pg_get_functiondef から起こし、その1か所だけ置き換えた。目印の2つはそのまま）
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
  if p_choice is null or p_choice not in (1, 2, 3, 4) then
    return query select false, '回答を選んでください'::text; return;
  end if;
  if p_choice = 4 and v_note is null then
    return query select false, '「その他」を選んだときは内容を書いてください'::text; return;
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

  -- 回答（同じ奨励日・同じ人は1件だけ。2回目はここで止める）
  insert into paid_leave_encouragement_responses (encouragement_day_id, user_id, choice, note)
  values (p_day_id, v_uid, p_choice, v_note)
  on conflict (encouragement_day_id, user_id) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted = 0 then
    return query select false, 'すでに回答済みです'::text; return;
  end if;

  -- 休暇（いまの画面と同じ値。🚨 出勤のチェックが入っていれば作らない）
  if not (p_choice = 4 and coalesce(p_working, false)) then
    v_leave_type := case p_choice when 1 then '有給休暇' when 2 then '調整休' else 'その他' end;
    v_type_other := case p_choice when 3 then '定休日' when 4 then coalesce(v_note, 'その他') else null end;

    -- 何度動いても二重にならないよう、同じ人・同じ日・奨励日由来の行が無いときだけ作る
    -- 🚨 表の別名（lr）を必ず付ける。`reason` は**戻り値の名前でもある**ので、裸で書くと
    --    「どちらの reason か分からない」で落ちる（42702）。場所予約の繰り上げで同じ形を踏んでいる
    if not exists (
      select 1 from leave_requests lr
      where lr.user_id = v_uid and lr.start_date = v_target_date and lr.reason = '【有給奨励日】'
    ) then
      insert into leave_requests (
        user_id, leave_type, leave_type_other, leave_dates, start_date, end_date,
        purpose, reason, status, current_approver
      ) values (
        v_uid, v_leave_type, v_type_other,
        to_json(array[to_char(v_target_date, 'YYYY-MM-DD')])::text,
        v_target_date, v_target_date,
        '有給奨励日', '【有給奨励日】', 'approved', 'none'
      );
    end if;
  end if;

  return query select true, null::text;
end;
$function$;

-- 2. 社内FAQ（答えの本文）
update public.faq_answers set body = replace(body, '有給奨励日', '有休奨励日')
 where id in ('b0000000-0000-4000-8000-000000000914', 'b0000000-0000-4000-8000-000000000915')
   and body like '%有給奨励日%';

-- 3. 社内FAQ（トピック）。🚨 検索の言葉には昔の書き方も残す（「有給奨励日」で探す人がいるため）
update public.faq_topics
   set question = replace(question, '有給奨励日', '有休奨励日'),
       keywords = array['有休奨励日', '有給奨励日', '奨励日', '回答', '4択']
 where id = 'f7080cd3-3e84-438c-aca7-5846dd9e8443';

-- 4. メール通知（未回答リマインド）の件名と本文
update public.notification_settings
   set subject = replace(subject, '有給奨励日', '有休奨励日'),
       template = replace(template, '有給奨励日', '有休奨励日'),
       updated_at = now()
 where id = '44e8ffc7-7727-4971-baee-a8723b7605f5';

commit;
