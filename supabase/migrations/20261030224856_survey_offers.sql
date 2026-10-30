-- 連絡板のアンケート 段2-1：ご提案 → 承諾 → 申請（2026-10-30・計画 docs/計画-連絡板のアンケート.md の「段2で決めたこと」1〜19）
-- ・担当者（アンケートを送った人・申請の依頼の権限あり）が回答を見て［この内容でご提案する］→ ご本人に「ご提案」が届く
-- ・ご本人［承諾する］→ 今の「申請の依頼」（application_requests）を1行作る（状態の値は増やさない）→ ご本人が申請すると今までどおり結び付く
-- ・ご本人［内容を相談したい］→ 担当者は直接相談して［決まった内容でもう一度ご提案する］（round を1つ進める）→ ご本人はもう一度［承諾する］
-- ・承諾の取り消し（［やはり相談したい］）は申請の前だけ。お知らせを消すときは、先に board_survey_offer_release で依頼を残す／取り下げるを決める
-- ・札の判定は board_survey_offer_states の1か所。ご本人の件数・カードは my_open_app_requests の1本
-- 🚨 書き込みは definer の関数だけ（表には select の決まりしか無い）。関数名は application_request_offer_* で始める（lib/writeWatch で依頼の話題になる＝ナビの数字が読み直される）
-- 🚨 ベルの event_key：ご本人あて application_request:offer（スマホは push-dispatch の EVENT_MAP に足すまで送られない＝段2-2）・担当者あて application_request:offer_reply（ベルだけ）

-- ── 表 ─────────────────────────────────────────────
create table if not exists public.board_survey_requests (
  id            uuid primary key default gen_random_uuid(),
  message_id    uuid not null references public.board_messages(id) on delete cascade,
  recipient_id  uuid not null references public.profiles(id) on delete cascade,
  requester_id  uuid not null references public.profiles(id) on delete cascade,
  status        text not null default 'awaiting' check (status in ('awaiting', 'consult', 'accepted', 'withdrawn')),
  round         int  not null default 1,
  kind          text not null check (kind in ('overtime', 'leave')),
  ot_content    text check (ot_content is null or ot_content in ('time', 'chosei_off', 'furikae_off', 'absence', 'self')),
  target_dates  date[] not null,
  memo          text check (memo is null or char_length(memo) <= 200),
  due_date      date,
  consult_note  text check (consult_note is null or char_length(consult_note) <= 200),
  prev          jsonb,          -- 2回目以降：前回の内容（「変わった所」を出すため）
  app_request_id uuid,          -- 承諾で作った申請の依頼（下で外部キー）
  app_status    text,           -- 依頼の状態の写し（依頼が90日で片付いても札を出せるように）
  linked_id     uuid,           -- 依頼が結び付いた申請の写し
  accepted_at   timestamptz,
  consulted_at  timestamptz,
  released_at   timestamptz,    -- お知らせを消す前の片付けが済んだ（board_survey_offer_release）
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (message_id, recipient_id)
);
alter table public.board_survey_requests enable row level security;
drop policy if exists bsr_select on public.board_survey_requests;
create policy bsr_select on public.board_survey_requests for select to authenticated
  using (recipient_id = auth.uid() or requester_id = auth.uid() or coalesce(public.is_admin(), false));
grant select on public.board_survey_requests to authenticated;
revoke insert, update, delete, truncate, references, trigger on public.board_survey_requests from authenticated;   -- 書くのは definer の関数だけ（既定の権限で付いても外す）
grant all on public.board_survey_requests to service_role;
revoke all on public.board_survey_requests from anon;
create index if not exists idx_bsr_recipient on public.board_survey_requests (recipient_id) where status in ('awaiting', 'accepted');

-- ── 申請の依頼とのつながり ───────────────────────────────
alter table public.application_requests add column if not exists survey_request_id uuid
  references public.board_survey_requests(id) on delete set null;
alter table public.board_survey_requests drop constraint if exists board_survey_requests_app_request_fk;
alter table public.board_survey_requests add constraint board_survey_requests_app_request_fk
  foreign key (app_request_id) references public.application_requests(id) on delete set null;
-- 1つのご提案から生きている依頼は1つだけ（二重の承諾を止める最後の網）
create unique index if not exists uq_appreq_survey_live on public.application_requests (survey_request_id)
  where survey_request_id is not null and status in ('open', 'applied');

-- ── 依頼の見張り（20261030223035 の enforce_appreq_transition に、ご提案から作った依頼の決まりを足した）──
create or replace function public.enforce_appreq_transition()
returns trigger
language plpgsql
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  v_admin boolean := coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
begin
  if current_user <> 'authenticated' or v_admin then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if coalesce(new.status, 'open') <> 'open' or new.linked_id is not null or new.responded_at is not null or new.recipient_note is not null
       or new.survey_request_id is not null then
      raise exception 'APPREQ|依頼は「まだ申請されていない」状態でしか作れません' using errcode = 'check_violation';
    end if;
    return new;
  end if;
  if new.id <> old.id or new.created_at is distinct from old.created_at
     or new.memo is distinct from old.memo or new.due_date is distinct from old.due_date
     or new.consulted_on is distinct from old.consulted_on or new.segments is distinct from old.segments
     or new.survey_request_id is distinct from old.survey_request_id then
    raise exception 'APPREQ|依頼の中身はあとから変えられません。取り下げてから作り直してください' using errcode = 'check_violation';
  end if;
  if new.status = old.status and new.linked_id is not distinct from old.linked_id
     and new.recipient_note is not distinct from old.recipient_note then
    return new;
  end if;
  if old.status = 'open' and new.status = 'applied' and v_uid = old.recipient_id and new.linked_id is not null
     and new.recipient_note is not distinct from old.recipient_note
     and ((old.kind = 'overtime' and exists (select 1 from overtime_reports o where o.id = new.linked_id and o.applicant_id = v_uid and o.status <> 'cancelled'))
       or (old.kind = 'leave' and exists (select 1 from leave_requests l where l.id = new.linked_id and l.user_id = v_uid and l.status <> 'cancelled'))) then
    return new;
  end if;
  -- 🚨 ご提案から作った依頼は［対応しない］［取り下げ］を画面から直接できない（承諾の取り消し・お知らせの削除の関数だけ）
  if old.survey_request_id is not null then
    raise exception 'APPREQ|ご提案から作った依頼は、ここでは変えられません。ご提案のカードから操作してください' using errcode = 'check_violation';
  end if;
  if old.status = 'open' and new.status = 'dismissed' and v_uid = old.recipient_id and new.linked_id is null then
    return new;
  end if;
  if old.status = 'open' and new.status = 'withdrawn' and v_uid = old.requester_id and new.linked_id is null
     and new.recipient_note is not distinct from old.recipient_note then
    return new;
  end if;
  raise exception 'APPREQ|この依頼の状態は変えられません（すでに処理された可能性があります）' using errcode = 'check_violation';
end;
$$;
revoke execute on function public.enforce_appreq_transition() from public;
revoke execute on function public.enforce_appreq_transition() from anon;

-- ── 依頼の状態をご提案に写す ─────────────────────────────
create or replace function public.copy_appreq_to_survey_offer()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if new.survey_request_id is not null
     and (new.status is distinct from old.status or new.linked_id is distinct from old.linked_id) then
    update board_survey_requests
       set app_status = new.status, linked_id = new.linked_id, updated_at = now()
     where id = new.survey_request_id;
  end if;
  return new;
end;
$$;
revoke execute on function public.copy_appreq_to_survey_offer() from public;
revoke execute on function public.copy_appreq_to_survey_offer() from anon;
revoke execute on function public.copy_appreq_to_survey_offer() from authenticated;
drop trigger if exists trg_appreq_copy_to_offer on public.application_requests;
create trigger trg_appreq_copy_to_offer after update on public.application_requests
  for each row execute function public.copy_appreq_to_survey_offer();

-- ── 内部の部品 ──────────────────────────────────────────
-- お知らせの件名（ベルの文に使う）
create or replace function public.board_survey_subject(p_message_id uuid)
returns text
language sql
stable
security definer
set search_path to 'public'
as $$
  select left(coalesce(nullif(btrim(m.subject), ''), nullif(btrim(m.title), ''), 'アンケート'), 40) from board_messages m where m.id = p_message_id;
$$;
revoke execute on function public.board_survey_subject(uuid) from public;
revoke execute on function public.board_survey_subject(uuid) from anon;
revoke execute on function public.board_survey_subject(uuid) from authenticated;

-- ベルを1件（宛先1人・設定の配りに乗せない）
create or replace function public.board_survey_bell(p_user uuid, p_message text, p_ref uuid, p_event text, p_by uuid)
returns void
language sql
security definer
set search_path to 'public'
as $$
  insert into notifications (user_id, message, source_type, reference_id, event_key, created_by)
  values (p_user, p_message, 'application_request', p_ref::text, p_event, p_by);
$$;
revoke execute on function public.board_survey_bell(uuid, text, uuid, text, uuid) from public;
revoke execute on function public.board_survey_bell(uuid, text, uuid, text, uuid) from anon;
revoke execute on function public.board_survey_bell(uuid, text, uuid, text, uuid) from authenticated;

-- ── ご提案を送る（1回目・2回目以降）──────────────────────────
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
      v_id, 'application_request:offer', v_uid);
  else
    insert into board_survey_requests (message_id, recipient_id, requester_id, kind, ot_content, target_dates, memo, due_date)
    values (m.id, p_recipient_id, v_uid, p_kind, p_ot_content, v_dates, v_memo, p_due)
    returning id into v_id;
    perform public.board_survey_bell(p_recipient_id,
      '📩 申請についてのご提案があります（' || public.board_survey_subject(m.id) || '）',
      v_id, 'application_request:offer', v_uid);
  end if;
  return v_id;
end;
$$;
revoke execute on function public.application_request_offer_send(uuid, uuid, text, text, date[], text, date, timestamptz) from public;
revoke execute on function public.application_request_offer_send(uuid, uuid, text, text, date[], text, date, timestamptz) from anon;
grant execute on function public.application_request_offer_send(uuid, uuid, text, text, date[], text, date, timestamptz) to authenticated;

-- ── 承諾する ─────────────────────────────────────────────
create or replace function public.application_request_offer_accept(p_offer_id uuid, p_round int)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  o board_survey_requests;
  v_req uuid;
  v_match uuid;
  v_name text;
begin
  if v_uid is null then raise exception 'ログインが必要です' using errcode = '42501'; end if;
  select * into o from board_survey_requests where id = p_offer_id for update;
  if not found or o.recipient_id <> v_uid then raise exception 'このご提案は見つかりません' using errcode = '42501'; end if;
  if o.status = 'accepted' and o.round = p_round and o.app_request_id is not null then
    -- 押し直し：同じ依頼を返す
    return jsonb_build_object('app_request_id', o.app_request_id, 'applied', o.app_status = 'applied');
  end if;
  if o.status <> 'awaiting' then raise exception 'このご提案は、いま承諾できません（取り下げ・相談中など）。画面を更新してください' using errcode = '22023'; end if;
  if o.round <> p_round then raise exception 'ご提案の内容が変わりました。画面を更新してから、もう一度ご確認ください' using errcode = '22023'; end if;
  if not exists (select 1 from profiles p where p.id = o.requester_id and coalesce(p.is_active, true)) then
    raise exception 'ご提案した方が在籍していないため、承諾できません' using errcode = '22023';
  end if;

  insert into application_requests (requester_id, recipient_id, kind, target_dates, memo, due_date, ot_content, survey_request_id)
  values (o.requester_id, o.recipient_id, o.kind, o.target_dates, o.memo, o.due_date, o.ot_content, o.id)
  returning id into v_req;
  -- すでに合う申請を出していれば、その場で結ぶ
  v_match := public.appreq_match_application(v_req);
  if v_match is not null then
    update application_requests set status = 'applied', linked_id = v_match, responded_at = now(), updated_at = now() where id = v_req;
  end if;
  update board_survey_requests
     set status = 'accepted', app_request_id = v_req, app_status = case when v_match is null then 'open' else 'applied' end,
         linked_id = v_match, accepted_at = now(), consult_note = null, updated_at = now()
   where id = o.id;

  select name into v_name from profiles where id = v_uid;
  perform public.board_survey_bell(o.requester_id,
    '📩 ' || coalesce(v_name, '') || 'さんがご提案を承諾しました（' || public.board_survey_subject(o.message_id) || '）',
    o.id, 'application_request:offer_reply', v_uid);
  return jsonb_build_object('app_request_id', v_req, 'applied', v_match is not null);
end;
$$;
revoke execute on function public.application_request_offer_accept(uuid, int) from public;
revoke execute on function public.application_request_offer_accept(uuid, int) from anon;
grant execute on function public.application_request_offer_accept(uuid, int) to authenticated;

-- ── 内容を相談したい（承諾の前）／やはり相談したい（承諾のあと・申請の前）──────────
create or replace function public.application_request_offer_consult(p_offer_id uuid, p_round int, p_note text)
returns void
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  o board_survey_requests;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_name text;
  v_after boolean;
begin
  if v_uid is null then raise exception 'ログインが必要です' using errcode = '42501'; end if;
  if v_note is null then raise exception '相談したい内容を書いてください' using errcode = '22023'; end if;
  if char_length(v_note) > 200 then raise exception '相談したい内容は200字までです' using errcode = '22023'; end if;
  select * into o from board_survey_requests where id = p_offer_id for update;
  if not found or o.recipient_id <> v_uid then raise exception 'このご提案は見つかりません' using errcode = '42501'; end if;
  if o.round <> p_round then raise exception 'ご提案の内容が変わりました。画面を更新してください' using errcode = '22023'; end if;
  if o.status = 'awaiting' then
    v_after := false;
  elsif o.status = 'accepted' then
    -- 申請したあとは取り消せない（申請の画面から取消・修正の依頼をする）
    if exists (select 1 from application_requests a where a.id = o.app_request_id and a.status = 'applied') then
      raise exception 'すでに申請しているため、承諾は取り消せません' using errcode = '22023';
    end if;
    update application_requests set status = 'withdrawn', updated_at = now() where id = o.app_request_id and status = 'open';
    v_after := true;
  else
    raise exception 'このご提案は、いま相談できません。画面を更新してください' using errcode = '22023';
  end if;
  update board_survey_requests
     set status = 'consult', consult_note = v_note, consulted_at = now(), app_request_id = null, app_status = null, linked_id = null,
         accepted_at = null, updated_at = now()
   where id = o.id;
  select name into v_name from profiles where id = v_uid;
  perform public.board_survey_bell(o.requester_id,
    '📩 ' || coalesce(v_name, '') || 'さんから、ご提案の内容について相談があります' || case when v_after then '（承諾を取り消し）' else '' end
      || '：' || left(v_note, 40),
    o.id, 'application_request:offer_reply', v_uid);
end;
$$;
revoke execute on function public.application_request_offer_consult(uuid, int, text) from public;
revoke execute on function public.application_request_offer_consult(uuid, int, text) from anon;
grant execute on function public.application_request_offer_consult(uuid, int, text) to authenticated;

-- ── お知らせを消す前の片付け（依頼を残す／取り下げる）──────────────
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
       where user_id = o.recipient_id and reference_id = o.id::text and event_key = 'application_request:offer' and coalesce(read, false) = false;
    end if;
    update board_survey_requests set released_at = now() where id = o.id;
  end loop;
  return jsonb_build_object('withdrawn', v_withdrawn, 'kept', v_kept);
end;
$$;
revoke execute on function public.board_survey_offer_release(uuid, boolean) from public;
revoke execute on function public.board_survey_offer_release(uuid, boolean) from anon;
grant execute on function public.board_survey_offer_release(uuid, boolean) to authenticated;

-- 最後の網：片付けをせずに、ご提案の残るお知らせを消そうとしたら止める（古い画面・まとめての削除）
create or replace function public.guard_board_message_offers_delete()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  if exists (select 1 from board_survey_requests sr
              left join application_requests a on a.id = sr.app_request_id
              where sr.message_id = old.id and sr.released_at is null
                and (sr.status in ('awaiting', 'consult') or (sr.status = 'accepted' and a.status = 'open'))) then
    raise exception 'ご提案が残っているため、このお知らせは削除できません。画面を更新してから、もう一度削除してください' using errcode = 'check_violation';
  end if;
  return old;
end;
$$;
revoke execute on function public.guard_board_message_offers_delete() from public;
revoke execute on function public.guard_board_message_offers_delete() from anon;
revoke execute on function public.guard_board_message_offers_delete() from authenticated;
drop trigger if exists trg_board_message_offers_delete on public.board_messages;
create trigger trg_board_message_offers_delete before delete on public.board_messages
  for each row execute function public.guard_board_message_offers_delete();

-- ── 札の判定（1か所）：担当者の回答の一覧で、受け取った人ごとの札 ─────────────
-- label：awaiting（返事待ち）／overdue（期限切れ）／consult（内容を相談したい）／accepted_unapplied（承諾済み・申請待ち）／
--        applied_pending（受理待ち）／pre_approved（事前申請 受理済み）／approved（受理済み）／returned（差し戻し中）／withdrawn（取り下げ）
create or replace function public.board_survey_offer_states(p_message_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_uid uuid := auth.uid();
  m board_messages;
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
begin
  if v_uid is null then raise exception 'ログインが必要です' using errcode = '42501'; end if;
  select * into m from board_messages where id = p_message_id;
  if not found then return '[]'::jsonb; end if;
  if not (coalesce(public.is_admin(), false) or m.user_id = v_uid
          or (m.cc_user_ids is not null and v_uid::text = any (m.cc_user_ids) and board_is_notice_cc_rep())) then
    raise exception 'ご提案の状態を見る権限がありません' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'recipient_id', sr.recipient_id, 'offer_id', sr.id, 'round', sr.round, 'status', sr.status,
      'kind', sr.kind, 'ot_content', sr.ot_content, 'target_dates', to_jsonb(sr.target_dates), 'memo', sr.memo,
      'due_date', sr.due_date, 'consult_note', sr.consult_note, 'prev', sr.prev, 'updated_at', sr.updated_at,
      'label', case
        when sr.status = 'withdrawn' then 'withdrawn'
        when sr.status = 'consult' then 'consult'
        when sr.status = 'awaiting' then case when sr.due_date is not null and sr.due_date < v_today then 'overdue' else 'awaiting' end
        -- 承諾のあと：依頼の今の状態（依頼が片付いていれば写し）→ 結び付いた申請の今の状態
        when coalesce(a.status, sr.app_status) = 'withdrawn' then 'withdrawn'
        when coalesce(a.status, sr.app_status) = 'applied' or coalesce(a.linked_id, sr.linked_id) is not null then
          case
            when sr.kind = 'overtime' then case coalesce(ot.status, '__none__')
              when 'request_confirmed' then 'pre_approved'
              when 'confirmed' then 'approved'
              when 'returned' then 'returned'
              when 'cancelled' then 'accepted_unapplied'
              when '__none__' then 'accepted_unapplied'
              else 'applied_pending' end
            else case coalesce(lv.status, '__none__')
              when 'approved' then 'approved'
              when 'rejected' then 'returned'
              when 'cancelled' then 'accepted_unapplied'
              when '__none__' then 'accepted_unapplied'
              else 'applied_pending' end
          end
        else 'accepted_unapplied'
      end) order by sr.created_at)
      from board_survey_requests sr
      left join application_requests a on a.id = sr.app_request_id
      left join overtime_reports ot on sr.kind = 'overtime' and ot.id = coalesce(a.linked_id, sr.linked_id)
      left join leave_requests lv on sr.kind = 'leave' and lv.id = coalesce(a.linked_id, sr.linked_id)
     where sr.message_id = m.id), '[]'::jsonb);
end;
$$;
revoke execute on function public.board_survey_offer_states(uuid) from public;
revoke execute on function public.board_survey_offer_states(uuid) from anon;
grant execute on function public.board_survey_offer_states(uuid) to authenticated;

-- ── ご本人：届いている依頼とご提案（ナビの数字・ホームの帯・依頼のカードを1本で）──────────
-- 🚨 名前は my_ で始める（lib/writeWatch で読むだけとして扱われる）。「内容を相談したい」のご提案は数えない（2026-10-30 ユーザー確定）
create or replace function public.my_open_app_requests()
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'requests', coalesce((select jsonb_agg(jsonb_build_object(
        'id', a.id, 'requester_id', a.requester_id, 'requester_name', p.name, 'kind', a.kind, 'target_dates', to_jsonb(a.target_dates),
        'memo', a.memo, 'due_date', a.due_date, 'consulted_on', a.consulted_on, 'segments', a.segments, 'ot_content', a.ot_content,
        'replaces_leave_id', a.replaces_leave_id, 'survey_request_id', a.survey_request_id,
        'survey_subject', case when a.survey_request_id is not null then public.board_survey_subject(sr.message_id) end,
        'offer_round', sr.round) order by a.due_date nulls last, a.created_at)
      from application_requests a
      left join profiles p on p.id = a.requester_id
      left join board_survey_requests sr on sr.id = a.survey_request_id
     where a.recipient_id = auth.uid() and a.status = 'open'), '[]'::jsonb),
    'offers', coalesce((select jsonb_agg(jsonb_build_object(
        'offer_id', sr.id, 'message_id', sr.message_id, 'subject', public.board_survey_subject(sr.message_id),
        'requester_id', sr.requester_id, 'requester_name', p.name, 'round', sr.round, 'kind', sr.kind, 'ot_content', sr.ot_content,
        'target_dates', to_jsonb(sr.target_dates), 'memo', sr.memo, 'due_date', sr.due_date, 'prev', sr.prev,
        'created_at', sr.created_at, 'updated_at', sr.updated_at) order by sr.due_date nulls last, sr.updated_at)
      from board_survey_requests sr
      left join profiles p on p.id = sr.requester_id
     where sr.recipient_id = auth.uid() and sr.status = 'awaiting'), '[]'::jsonb)
  );
$$;
revoke execute on function public.my_open_app_requests() from public;
revoke execute on function public.my_open_app_requests() from anon;
grant execute on function public.my_open_app_requests() to authenticated;

-- ── 回答（本番の実定義から・ご提案が届いたら直せない止めを足した）──────────────
CREATE OR REPLACE FUNCTION public.board_survey_answer(p_message_id uuid, p_answers jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  m board_messages;
  v_ex board_survey_answers;
  q jsonb; a jsonb; k text;
  v_qids text[] := '{}';
  v_opts text[];
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_late boolean;
  v_clean jsonb := '{}'::jsonb;
  v_val jsonb; v_choice text; v_choices text[]; v_other text; v_text text; v_dates text[]; v_d date;
  v_empty boolean; v_n int := 0;
begin
  if v_uid is null then raise exception 'ログインが必要です' using errcode = '42501'; end if;
  if p_answers is null or jsonb_typeof(p_answers) <> 'object' then raise exception '回答の形が正しくありません' using errcode = '22023'; end if;
  if pg_column_size(p_answers) > 64000 then raise exception '回答が長すぎます' using errcode = '22023'; end if;

  -- 🚨 for share：送った人が質問を直す（UPDATE）と同時に回答できないように
  select * into m from board_messages where id = p_message_id for share;
  if not found or m.survey is null then raise exception 'このお知らせはアンケートではありません' using errcode = '22023'; end if;
  if m.status <> 'sent' or m.send_hold then raise exception 'このアンケートはまだ届いていません' using errcode = '22023'; end if;
  if not exists (select 1 from board_message_recipients r where r.message_id = m.id and r.user_id = v_uid) then
    raise exception 'このアンケートの宛先ではありません' using errcode = '42501';
  end if;

  select * into v_ex from board_survey_answers where message_id = m.id and user_id = v_uid for update;
  v_late := m.deadline is not null and v_today > m.deadline;
  -- 2026-10-30 段2-1：担当者のご提案が届いたら、回答は直せない（取り下げられたご提案は除く）。🚨 鍵の順番は回答の行→ご提案の行（ご提案を送る関数と同じ）
  if found and exists (select 1 from board_survey_requests sr where sr.message_id = m.id and sr.recipient_id = v_uid and sr.status <> 'withdrawn') then
    raise exception 'ご提案が届いているため、回答は直せません。変えたいときは、ご提案の［内容を相談したい］からお知らせください' using errcode = '22023';
  end if;
  if found and v_late then raise exception '期限を過ぎているため、回答は直せません' using errcode = '22023'; end if;

  for q in select value from jsonb_array_elements(m.survey -> 'questions') loop
    v_n := v_n + 1;
    k := q ->> 'id';
    v_qids := v_qids || k;
    v_val := p_answers -> k;
    v_empty := true;
    if v_val is not null and jsonb_typeof(v_val) = 'object' then
      if q ->> 'kind' = 'single' then
        v_choice := nullif(v_val ->> 'choice', '');
        if v_choice is not null then
          select array_agg(o ->> 'id') into v_opts from jsonb_array_elements(q -> 'options') o;
          if v_choice = '__other__' then
            if not coalesce((q ->> 'allow_other')::boolean, false) then raise exception '%問目に「その他」はありません', v_n using errcode = '22023'; end if;
            v_other := btrim(coalesce(v_val ->> 'other', ''));
            if v_other = '' then raise exception '%問目の「その他」の内容を書いてください', v_n using errcode = '22023'; end if;
            if char_length(v_other) > 200 then raise exception '%問目の「その他」は200字までです', v_n using errcode = '22023'; end if;
            v_clean := v_clean || jsonb_build_object(k, jsonb_build_object('choice', '__other__', 'other', v_other));
          else
            if not (v_choice = any (v_opts)) then raise exception '%問目の選択肢が見つかりません。画面を更新してください', v_n using errcode = '22023'; end if;
            v_clean := v_clean || jsonb_build_object(k, jsonb_build_object('choice', v_choice));
          end if;
          v_empty := false;
        end if;
      elsif q ->> 'kind' = 'multi' then
        if jsonb_typeof(v_val -> 'choices') = 'array' and jsonb_array_length(v_val -> 'choices') > 0 then
          select array_agg(o ->> 'id') into v_opts from jsonb_array_elements(q -> 'options') o;
          select array_agg(distinct x) into v_choices from jsonb_array_elements_text(v_val -> 'choices') x;
          if exists (select 1 from unnest(v_choices) c where c <> '__other__' and not (c = any (v_opts))) then
            raise exception '%問目の選択肢が見つかりません。画面を更新してください', v_n using errcode = '22023'; end if;
          v_other := null;
          if '__other__' = any (v_choices) then
            if not coalesce((q ->> 'allow_other')::boolean, false) then raise exception '%問目に「その他」はありません', v_n using errcode = '22023'; end if;
            v_other := btrim(coalesce(v_val ->> 'other', ''));
            if v_other = '' then raise exception '%問目の「その他」の内容を書いてください', v_n using errcode = '22023'; end if;
            if char_length(v_other) > 200 then raise exception '%問目の「その他」は200字までです', v_n using errcode = '22023'; end if;
          end if;
          -- 並びは質問の選択肢の順にそろえる
          v_clean := v_clean || jsonb_build_object(k, jsonb_strip_nulls(jsonb_build_object(
            'choices', (select jsonb_agg(c order by coalesce(array_position(v_opts, c), 9999)) from unnest(v_choices) c),
            'other', v_other)));
          v_empty := false;
        end if;
      elsif q ->> 'kind' = 'text' then
        v_text := btrim(coalesce(v_val ->> 'text', ''));
        if v_text <> '' then
          if char_length(v_text) > 1000 then raise exception '%問目は1000字までです', v_n using errcode = '22023'; end if;
          v_clean := v_clean || jsonb_build_object(k, jsonb_build_object('text', v_text));
          v_empty := false;
        end if;
      elsif q ->> 'kind' = 'date' then
        if jsonb_typeof(v_val -> 'dates') = 'array' and jsonb_array_length(v_val -> 'dates') > 0 then
          if jsonb_array_length(v_val -> 'dates') > 31 then raise exception '%問目の日付は31日までです', v_n using errcode = '22023'; end if;
          v_dates := '{}';
          for v_d in select distinct x::date from jsonb_array_elements_text(v_val -> 'dates') x order by 1 loop
            if (q ->> 'date_from') is not null and v_d < (q ->> 'date_from')::date
               or (q ->> 'date_to') is not null and v_d > (q ->> 'date_to')::date then
              raise exception '%問目の日付が選べる範囲の外です', v_n using errcode = '22023'; end if;
            v_dates := v_dates || v_d::text;
          end loop;
          v_clean := v_clean || jsonb_build_object(k, jsonb_build_object('dates', to_jsonb(v_dates)));
          v_empty := false;
        end if;
      end if;
    elsif v_val is not null and jsonb_typeof(v_val) <> 'null' then
      raise exception '%問目の回答の形が正しくありません', v_n using errcode = '22023';
    end if;
    if v_empty and coalesce((q ->> 'required')::boolean, false) then
      raise exception '%問目は必須です', v_n using errcode = '22023';
    end if;
  end loop;

  -- 知らない質問の回答は断る（古い画面・質問が直されたあと）
  if exists (select 1 from jsonb_object_keys(p_answers) x where not (x = any (v_qids))) then
    raise exception '質問が変わっています。画面を更新してから回答してください' using errcode = '22023';
  end if;

  if v_ex.message_id is null then
    insert into board_survey_answers (message_id, user_id, answers, answered_at, updated_at, edit_count, is_late)
    values (m.id, v_uid, v_clean, now(), now(), 0, v_late);
  else
    update board_survey_answers
       set answers = v_clean, updated_at = now(), edit_count = edit_count + 1
     where message_id = m.id and user_id = v_uid;
  end if;

  -- 「回答済み」（未対応の数・回答報告）は今の board_confirmations をそのまま使う。🚨 中身は書かない（固定の文）
  perform set_config('app.survey_answer', 'on', true);
  insert into board_confirmations (message_id, user_id, comment)
  values (m.id, v_uid, 'アンケートに回答')
  on conflict on constraint board_confirmations_pkey do nothing;
  perform set_config('app.survey_answer', '', true);

  return (select jsonb_build_object('answered_at', a2.answered_at, 'updated_at', a2.updated_at,
                                    'edit_count', a2.edit_count, 'is_late', a2.is_late, 'answers', a2.answers)
            from board_survey_answers a2 where a2.message_id = m.id and a2.user_id = v_uid);
end;
$function$
;
