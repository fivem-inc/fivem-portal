-- 打刻の確認：日ごとに「その日のひとこと」（経理から・任意・200字まで）を書けるようにする（2026-10-22 経理担当の意見・ユーザー確定）
-- ・これまで送る側の一言は確認1件に1つだけ（overtime_clock_inquiries.message）。全体の一言は今までどおり残す
-- ・send_overtime_clock_inquiry は本番の実定義（2026-10-22 に pg_get_functiondef で読んだもの）から起こし、p_days の各要素の note を ask_note に入れるだけ足した（引数・ほかの動きは変えていない）

alter table public.overtime_clock_inquiry_days
  add column if not exists ask_note text check (ask_note is null or length(ask_note) <= 200);
comment on column public.overtime_clock_inquiry_days.ask_note is 'その日のひとこと（経理から・任意・200字まで）。本人の回答画面でその日の下に出す';

CREATE OR REPLACE FUNCTION public.send_overtime_clock_inquiry(p_user_id uuid, p_days jsonb, p_message text DEFAULT NULL::text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_id        uuid;
  v_today     date := (now() at time zone 'Asia/Tokyo')::date;
  e           jsonb;
  v_date      date;
  v_pps       date;
  v_deadline  date;
  v_dates     date[] := '{}';
  v_label     text;
  v_site_on   boolean;
  v_side      text;
  v_note      text;   -- 2026-10-22：その日のひとこと（経理から・任意）
begin
  if not coalesce(is_admin(), false) then
    raise exception '打刻の確認を送れるのは経理（管理者）だけです';
  end if;
  if p_user_id is null then
    raise exception '対象者を選んでください';
  end if;
  if jsonb_typeof(p_days) <> 'array' or jsonb_array_length(p_days) = 0 then
    raise exception '対象の日を1日以上選んでください';
  end if;

  -- 同じ日に未回答の確認が既にあるなら送らない。
  -- 二度聞きになるうえ、両方に「打刻が遅れただけ」と答えると
  -- 2件目の記録作成が uq_overtime_manual_per_day で 23505 になる。
  if exists (
    select 1
      from public.overtime_clock_inquiry_days d
      join public.overtime_clock_inquiries i on i.id = d.inquiry_id
     where i.user_id = p_user_id
       and i.status  = 'open'
       and d.work_date in (
         select (x ->> 'work_date')::date from jsonb_array_elements(p_days) x
       )
  ) then
    raise exception 'この日はすでに確認を送っています（未回答）' using errcode = 'P0001';
  end if;

  insert into public.overtime_clock_inquiries (user_id, sender_id, message)
  values (p_user_id, auth.uid(), nullif(btrim(coalesce(p_message, '')), ''))
  returning id into v_id;

  for e in select * from jsonb_array_elements(p_days) loop
    v_date := (e ->> 'work_date')::date;
    if v_date is null then
      raise exception '日付が正しくありません';
    end if;
    -- 何について聞くか（2026-10-13）：after＝退勤のあと（今まで）／before＝出勤前／both＝両方。渡されなければ after
    v_side := coalesce(nullif(e ->> 'ask_side', ''), 'after');
    if v_side not in ('after', 'before', 'both') then
      raise exception '聞くことが正しくありません（%）', v_side;
    end if;
    v_note := nullif(btrim(coalesce(e ->> 'note', '')), '');
    if v_note is not null and length(v_note) > 200 then
      raise exception 'その日のひとことは200字までにしてください（%）', to_char(v_date, 'MM/DD');
    end if;

    insert into public.overtime_clock_inquiry_days
      (inquiry_id, work_date, shift_start, shift_end, shift_start2, shift_end2, clock_in, clock_out, clock_in2, clock_out2, ask_side, ask_note)
    values (
      v_id, v_date,
      nullif(e ->> 'shift_start', '')::time,
      nullif(e ->> 'shift_end',   '')::time,
      nullif(e ->> 'shift_start2','')::time,
      nullif(e ->> 'shift_end2',  '')::time,
      nullif(e ->> 'clock_in',    '')::time,
      nullif(e ->> 'clock_out',   '')::time,
      nullif(e ->> 'clock_in2',   '')::time,
      nullif(e ->> 'clock_out2',  '')::time,
      v_side,
      v_note
    )
    on conflict (inquiry_id, work_date) do nothing;

    if not (v_date = any(v_dates)) then
      v_dates := v_dates || v_date;   -- 同じ日を2回渡されても件数ラベルを狂わせない
    end if;

    -- 締め後でも本人が報告できるよう、その日だけ許可を付ける。
    -- ただし給与データ確定日を過ぎた期には付けない（支給済みの期に新規行が入る道を作らない）
    v_pps      := public.calc_pay_period_start(v_date);
    v_deadline := public.overtime_grant_deadline(v_pps);
    if v_deadline is null or v_today <= v_deadline then
      insert into public.overtime_submission_grants (user_id, work_date, granted_by, note, source)
      values (p_user_id, v_date, auth.uid(),
              '打刻の確認（' || to_char(v_date, 'MM/DD') || '）', 'clock_inquiry')
      -- 生きている許可がある日は触らない。
      -- 経理が手で付けた許可を clock_inquiry に乗っ取ると、
      -- 回答後に link_clock_inquiry_result が勝手に閉じてしまう。
      -- 取消済みの行だけ、打刻の確認由来として引き取る（回答後に閉じられる状態にする）。
      on conflict (user_id, work_date) do update
        set revoked_at = null,
            revoked_by = null,
            granted_by = excluded.granted_by,
            note       = excluded.note,
            source     = excluded.source
        where overtime_submission_grants.revoked_at is not null;
    end if;
  end loop;

  -- 本人への通知（管理者が送るので RLS は通るが、部分成功を避けるためここで作る）
  -- ⚠️ 本文に「お知らせ」「リマインド」「メッセージが届き」「への対応がまだ完了していません」を入れない
  --    （App.tsx の連絡板判定・催促判定が先に効いてタップで /board に飛ぶ）
  select to_char(min(t.d), 'MM/DD') ||
         case when count(*) > 1 then ' 他' || (count(*) - 1) || '日' else '' end
    into v_label
    from unnest(v_dates) as t(d);

  -- 管理画面のON/OFFに従う（行が無ければ送る）。設定はあるのに効かない「死に設定」を作らない
  select enabled into v_site_on from public.notification_settings
   where event_key = 'overtime:clock_inquiry' and channel = 'site';

  if coalesce(v_site_on, true) then
    insert into public.notifications
      (user_id, message, sub_message, source_type, reference_id, event_key)
    values (
      p_user_id,
      '経理から勤務時間の確認です',
      v_label || '　タップして回答してください',
      'overtime:clock_inquiry', v_id::text, 'overtime:clock_inquiry'
    );
  end if;

  return v_id;
end; $function$;

revoke execute on function public.send_overtime_clock_inquiry(uuid, jsonb, text) from anon;
