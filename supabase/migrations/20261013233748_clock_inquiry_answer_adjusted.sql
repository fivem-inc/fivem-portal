-- 打刻の確認：申請が出ていない日の答えに「時間調整をしました（早退・遅出）」（answer='adjusted'）を足す（2026-10-13 ユーザー確定）
-- ・時間調整で早く帰った／遅く来たのに申請を出し忘れた日に、本人が「打刻が遅れただけ」を選んでしまう（本番で起きた）のを防ぐ
-- ・選んだら回答のあとに事後報告で調整早退／調整遅出を出す。申請が出たら確認と結び付けて締め後の許可を閉じる（「業務をしていました」と同じ）
-- ・answer_overtime_clock_inquiry と link_clock_inquiry_on_report_insert は本番の実定義から起こし、adjusted を足しただけ
begin;

alter table public.overtime_clock_inquiry_days drop constraint if exists overtime_clock_inquiry_days_answer_check;
alter table public.overtime_clock_inquiry_days add constraint overtime_clock_inquiry_days_answer_check
  check (answer in ('pending', 'worked', 'adjusted', 'not_worked', 'unknown', 'as_reported', 'time_differs', 'will_resubmit'));

CREATE OR REPLACE FUNCTION public.answer_overtime_clock_inquiry(p_inquiry_id uuid, p_days jsonb, p_note text DEFAULT NULL::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_claimed  int;
  v_sender   uuid;
  v_user     uuid;
  v_name     text;
  v_worked   int;
  v_not      int;
  v_unknown  int;
  v_asrep    int;
  v_differs  int;
  v_resub    int;
  v_adj      int;   -- 2026-10-13：時間調整をしました
  v_summary  text;
  v_site_on  boolean;
  v_day      record;
  v_e        jsonb;
  v_ans      text;
  v_st       record;
  v_segs     jsonb;
  v_seg      jsonb;
  v_prev_end int;
  v_s        int;
  v_t        int;
  v_note     text;
  v_link     uuid;
  v_label    text;
begin
  update public.overtime_clock_inquiries
     set status = 'answered', answered_at = now()
   where id = p_inquiry_id and user_id = auth.uid() and status = 'open'
  returning sender_id, user_id into v_sender, v_user;

  get diagnostics v_claimed = row_count;
  if v_claimed = 0 then
    return false;  -- 既に回答済み or 権限なし → 呼び出し側で案内を出す
  end if;

  -- 日ごとに、答える時点の申請の状態を見て、選べる答えかを確かめてから書く（2026-10-13）
  for v_day in
    select d.id, d.work_date from public.overtime_clock_inquiry_days d where d.inquiry_id = p_inquiry_id
  loop
    v_e := null;  -- 🚨 見つからないと前の日の値が残るので、毎回空にする
    select e into v_e from jsonb_array_elements(coalesce(p_days, '[]'::jsonb)) e
     where (e ->> 'day_id')::uuid = v_day.id limit 1;
    if v_e is null then continue; end if;  -- 未回答のまま → 下の pending の確かめで止まる
    v_ans := nullif(v_e ->> 'answer', '');
    if v_ans is null or v_ans = 'pending' then continue; end if;

    select * into v_st from public.clock_inquiry_day_state(v_user, v_day.work_date);
    v_label := to_char(v_day.work_date, 'FMMM/FMDD');

    if not (
      (v_st.state in ('none', 'leave') and v_ans in ('worked', 'adjusted', 'not_worked', 'unknown'))
      or (v_st.state in ('reported', 'planned') and v_ans in ('as_reported', 'time_differs', 'unknown'))
      or (v_st.state = 'returned' and v_ans in ('will_resubmit', 'unknown'))
      or (v_st.state = 'fullday' and v_ans in ('as_reported', 'unknown'))
    ) then
      raise exception 'CLOCK_INQ_STATE_CHANGED: % の申請の状態が変わっています。画面を読み込み直してから答えてください', v_label
        using errcode = 'P0001';
    end if;

    v_note := nullif(btrim(coalesce(v_e ->> 'note', '')), '');
    v_segs := null;
    if v_ans = 'time_differs' then
      if v_note is null then
        raise exception 'CLOCK_INQ_NOTE_REQUIRED: % のひとことを書いてください', v_label using errcode = 'P0001';
      end if;
      v_segs := v_e -> 'segments';
      if v_segs is null or jsonb_typeof(v_segs) <> 'array'
         or jsonb_array_length(v_segs) < 1 or jsonb_array_length(v_segs) > 3 then
        raise exception 'CLOCK_INQ_BAD_SEGMENTS: % の勤務時間を入れてください', v_label using errcode = 'P0001';
      end if;
      v_prev_end := -1;
      for v_seg in select x from jsonb_array_elements(v_segs) x loop
        v_s := (v_seg ->> 'start_min')::int;
        v_t := (v_seg ->> 'end_min')::int;
        if v_s is null or v_t is null or v_s < 0 or v_t <= v_s or v_t > 2880 or v_s < v_prev_end then
          raise exception 'CLOCK_INQ_BAD_SEGMENTS: % の勤務時間が正しくありません', v_label using errcode = 'P0001';
        end if;
        v_prev_end := v_t;
      end loop;
    end if;

    -- 申請がある日の答えは、その申請と確認を結び付ける（新しい記録は作らない）
    v_link := case when v_st.report_id is not null and v_ans in ('as_reported', 'time_differs', 'will_resubmit')
                   then v_st.report_id else null end;

    update public.overtime_clock_inquiry_days d set
      answer             = v_ans,
      answer_reason      = nullif(v_e ->> 'reason', ''),
      answer_note        = v_note,
      answer_segments    = v_segs,
      existing_report_id = v_st.report_id,
      report_state       = v_st.state,
      result_report_id   = coalesce(v_link, d.result_report_id)
    where d.id = v_day.id;

    if v_link is not null then
      update public.overtime_submission_grants
         set revoked_at = now()
       where user_id = v_user and work_date = v_day.work_date
         and source = 'clock_inquiry' and revoked_at is null;
    end if;
  end loop;

  -- 反映漏れ・空配列で「回答済みなのに全部 未回答」を作らない。
  -- この RPC は open のときだけ成立する＝やり直しがきかないので、ここで止める。
  -- 例外なら上の status 更新ごとロールバックされ、open のまま再試行できる。
  if exists (
    select 1 from public.overtime_clock_inquiry_days
     where inquiry_id = p_inquiry_id and answer = 'pending'
  ) then
    raise exception 'まだ回答していない日があります' using errcode = 'P0001';
  end if;

  select count(*) filter (where answer = 'worked'),
         count(*) filter (where answer = 'not_worked'),
         count(*) filter (where answer = 'unknown'),
         count(*) filter (where answer = 'as_reported'),
         count(*) filter (where answer = 'time_differs'),
         count(*) filter (where answer = 'will_resubmit'),
         count(*) filter (where answer = 'adjusted')
    into v_worked, v_not, v_unknown, v_asrep, v_differs, v_resub, v_adj
    from public.overtime_clock_inquiry_days where inquiry_id = p_inquiry_id;

  select name into v_name from public.profiles where id = auth.uid();

  v_summary := concat_ws('／',
    case when v_differs > 0 then '時刻が違う '       || v_differs || '日' end,
    case when v_resub   > 0 then '申請を出し直す '   || v_resub   || '日' end,
    case when v_asrep   > 0 then '申請の通り '       || v_asrep   || '日' end,
    case when v_not     > 0 then '定時（打刻が遅れただけ） ' || v_not || '日' end,
    case when v_worked  > 0 then '業務をしていた '   || v_worked  || '日' end,
    case when v_adj     > 0 then '時間調整をした '   || v_adj     || '日' end,
    case when v_unknown > 0 then '思い出せない '     || v_unknown || '日' end
  );
  if nullif(btrim(coalesce(p_note, '')), '') is not null then
    v_summary := v_summary || '　' || btrim(p_note);
  end if;

  select enabled into v_site_on from public.notification_settings
   where event_key = 'overtime:clock_inquiry_answered' and channel = 'site';

  if coalesce(v_site_on, true) then
    insert into public.notifications
      (user_id, message, sub_message, source_type, reference_id, event_key)
    values (
      v_sender,
      coalesce(v_name, 'スタッフ') || 'さんが勤務時間の確認に回答しました',
      v_summary,
      'overtime:clock_inquiry_answered', p_inquiry_id::text, 'overtime:clock_inquiry_answered'
    );
  end if;

  return true;
end; $function$;

CREATE OR REPLACE FUNCTION public.link_clock_inquiry_on_report_insert()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if new.entry_type is distinct from 'manual' or new.status = 'cancelled' then
    return null;
  end if;

  with linked as (
    update overtime_clock_inquiry_days d
       set result_report_id = new.id
      from overtime_clock_inquiries i
     where i.id = d.inquiry_id
       and i.user_id = new.applicant_id
       and i.status = 'answered'
       and d.answer in ('worked', 'adjusted')   -- 2026-10-13：時間調整をしました も、申請が出たら結び付ける
       and d.result_report_id is null
       and (d.work_date = new.work_date or d.work_date = new.furikae_origin_date)
    returning d.work_date
  )
  -- 打刻の確認で自動で開けた締め後の許可を閉じる（結び付いた日だけ）
  update overtime_submission_grants g
     set revoked_at = now()
   where g.user_id = new.applicant_id
     and g.source = 'clock_inquiry'
     and g.revoked_at is null
     and g.work_date in (select work_date from linked);

  return null;
end;
$function$;

revoke execute on function public.answer_overtime_clock_inquiry(uuid, jsonb, text) from public;
revoke execute on function public.answer_overtime_clock_inquiry(uuid, jsonb, text) from anon;
grant execute on function public.answer_overtime_clock_inquiry(uuid, jsonb, text) to authenticated;

commit;
