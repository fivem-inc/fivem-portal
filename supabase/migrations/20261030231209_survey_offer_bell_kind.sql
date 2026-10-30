-- 連絡板のアンケート 段2-2（2026-10-30）：ご提案のベルの種類を、休暇なら application_request:offer:leave に分ける
-- （スマホの通知を押したとき、休暇のご提案は休暇のページが開くように・push-dispatch の EVENT_MAP と対）
-- 20261030224856 の2つの関数（本番に入れた版）から、ベルの種類の所だけを直した

create or replace function public.application_request_offer_send(
  p_message_id uuid, p_recipient_id uuid, p_kind text, p_ot_content text, p_dates date[],
  p_memo text, p_due date, p_answer_seen timestamptz)
returns uuid
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  m board_messages;
  v_ans board_survey_answers;
  o board_survey_requests;
  v_id uuid;
  v_memo text := nullif(btrim(coalesce(p_memo, '')), '');
  v_dates date[];
begin
  if v_uid is null then raise exception 'ログインが必要です' using errcode = '42501'; end if;
  select * into m from board_messages where id = p_message_id;
  if not found or m.survey is null or not coalesce(m.survey_onegai, false) then
    raise exception 'このアンケートはご提案を使いません' using errcode = '22023';
  end if;
  if m.status <> 'sent' then raise exception 'このアンケートはまだ届いていません' using errcode = '22023'; end if;
  if not (coalesce(public.is_admin(), false)
          or (m.user_id = v_uid and public.user_has_feature_permission(v_uid, 'application_request'))) then
    raise exception 'ご提案を送る権限がありません' using errcode = '42501';
  end if;
  if p_kind not in ('overtime', 'leave') then raise exception '申請の種類が正しくありません' using errcode = '22023'; end if;
  if p_kind = 'leave' and p_ot_content is not null then raise exception '休暇の申請に残業の中身は付けられません' using errcode = '22023'; end if;
  if p_kind = 'overtime' and (p_ot_content is null or p_ot_content not in ('time', 'chosei_off', 'furikae_off', 'absence', 'self')) then
    raise exception '残業申請の中身を選んでください' using errcode = '22023';
  end if;
  select array_agg(distinct d order by d) into v_dates from unnest(p_dates) d where d is not null;
  if coalesce(array_length(v_dates, 1), 0) = 0 then raise exception '日付を選んでください' using errcode = '22023'; end if;
  if array_length(v_dates, 1) > 31 then raise exception '日付は31日までです' using errcode = '22023'; end if;
  if v_memo is not null and char_length(v_memo) > 200 then raise exception 'ひとことは200字までです' using errcode = '22023'; end if;
  if p_due is not null and p_due < v_today then raise exception '返事の期限は今日以降にしてください' using errcode = '22023'; end if;
  if not exists (select 1 from board_message_recipients r where r.message_id = m.id and r.user_id = p_recipient_id) then
    raise exception 'この方はアンケートの宛先ではありません' using errcode = '22023';
  end if;
  if not exists (select 1 from profiles p where p.id = p_recipient_id and coalesce(p.is_active, true))
     or public.staff_on_leave(p_recipient_id) then
    raise exception 'この方にはご提案を送れません（退職・休職中）' using errcode = '22023';
  end if;

  -- 🚨 鍵の順番は回答の行 → ご提案の行（board_survey_answer と同じ）
  select * into v_ans from board_survey_answers where message_id = m.id and user_id = p_recipient_id for update;
  if not found then raise exception 'この方はまだ回答していません' using errcode = '22023'; end if;
  if p_answer_seen is not null and v_ans.updated_at is distinct from p_answer_seen then
    raise exception 'この方の回答が変わりました。画面を更新してから、もう一度ご提案してください' using errcode = '22023';
  end if;

  select * into o from board_survey_requests where message_id = m.id and recipient_id = p_recipient_id for update;
  if found then
    if o.status = 'awaiting' then raise exception 'すでにご提案しています（返事待ち）' using errcode = '22023'; end if;
    if o.status = 'accepted' then raise exception 'この方はすでに承諾しています' using errcode = '22023'; end if;
    update board_survey_requests
       set status = 'awaiting', round = o.round + 1, kind = p_kind, ot_content = p_ot_content, target_dates = v_dates,
           memo = v_memo, due_date = p_due, consult_note = null, requester_id = v_uid,
           prev = jsonb_build_object('kind', o.kind, 'ot_content', o.ot_content, 'target_dates', to_jsonb(o.target_dates), 'consult_note', o.consult_note),
           app_request_id = null, app_status = null, linked_id = null, accepted_at = null, released_at = null, updated_at = now()
     where id = o.id;
    v_id := o.id;
    perform public.board_survey_bell(p_recipient_id,
      '📩 申請についてのご提案があります（' || (o.round + 1) || '回目・' || public.board_survey_subject(m.id) || '）',
      v_id, 'application_request:offer' || case when p_kind = 'leave' then ':leave' else '' end, v_uid);
  else
    insert into board_survey_requests (message_id, recipient_id, requester_id, kind, ot_content, target_dates, memo, due_date)
    values (m.id, p_recipient_id, v_uid, p_kind, p_ot_content, v_dates, v_memo, p_due)
    returning id into v_id;
    perform public.board_survey_bell(p_recipient_id,
      '📩 申請についてのご提案があります（' || public.board_survey_subject(m.id) || '）',
      v_id, 'application_request:offer' || case when p_kind = 'leave' then ':leave' else '' end, v_uid);
  end if;
  return v_id;
end;
$$;

create or replace function public.board_survey_offer_release(p_message_id uuid, p_keep boolean)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  m board_messages;
  o record;
  v_subject text;
  v_withdrawn int := 0;
  v_kept int := 0;
begin
  if v_uid is null then raise exception 'ログインが必要です' using errcode = '42501'; end if;
  select * into m from board_messages where id = p_message_id;
  if not found then return jsonb_build_object('withdrawn', 0, 'kept', 0); end if;
  if not (coalesce(public.is_admin(), false) or m.user_id = v_uid) then
    raise exception 'このお知らせを削除する権限がありません' using errcode = '42501';
  end if;
  v_subject := public.board_survey_subject(m.id);
  for o in select sr.*, a.status as a_status from board_survey_requests sr
             left join application_requests a on a.id = sr.app_request_id
            where sr.message_id = m.id and sr.released_at is null for update of sr loop
    if o.status = 'accepted' and o.a_status = 'open' then
      if p_keep then
        update application_requests set memo = left('【' || v_subject || '】' || coalesce(memo, ''), 500), updated_at = now() where id = o.app_request_id;
        v_kept := v_kept + 1;
      else
        update application_requests set status = 'withdrawn', updated_at = now() where id = o.app_request_id and status = 'open';
        update board_survey_requests set status = 'withdrawn', updated_at = now() where id = o.id;
        perform public.board_survey_bell(o.recipient_id, '📩 ご提案が取り下げられました（' || v_subject || '）', o.id, 'application_request:offer_reply', v_uid);
        v_withdrawn := v_withdrawn + 1;
      end if;
    elsif o.status in ('awaiting', 'consult') then
      update board_survey_requests set status = 'withdrawn', updated_at = now() where id = o.id;
      -- 届いているご提案のベルは既読に（開いても行き先が無くなるため）
      update notifications set read = true, read_at = coalesce(read_at, now()), banner_dismissed = true
       where user_id = o.recipient_id and reference_id = o.id::text and event_key in ('application_request:offer', 'application_request:offer:leave') and coalesce(read, false) = false;
    end if;
    update board_survey_requests set released_at = now() where id = o.id;
  end loop;
  return jsonb_build_object('withdrawn', v_withdrawn, 'kept', v_kept);
end;
$$;
