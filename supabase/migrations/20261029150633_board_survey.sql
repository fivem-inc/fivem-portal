-- 連絡板のアンケート 段1（2026-10-29・計画 docs/計画-連絡板のアンケート.md・UI/UX とシニアエンジニアの2体で2回レビュー）
--
-- ① お知らせ（channel_id・parent_id が null）の種別「✏️ 回答」に質問票を足す（board_messages.survey jsonb）
-- ② 回答は board_survey_answers（書くのは board_survey_answer だけ・読むのは本人の行と board_survey_results）
-- ③ 作れる人：お知らせを送れる人（app_settings board_notice_send_roles）かつ権限 'board_survey'（最初はマネージャー・社長・管理者）
-- ④ 今ある穴を2つ直す：
--    ・お知らせ送信権限が画面だけだった → board_messages のトリガーで DB でも守る（ふつうのお知らせにも効く）
--    ・board_confirmations の読む決まりが USING(true)＝「✏️ 回答」の文を全員が読めた → 自分の行・送った人・写しの代表者・管理者・グループのメンバーだけ。
--      ほかの人に出していた「◯人/◯人」は board_confirm_counts（件数だけ）に置き換える
--    ・board_confirmations に UPDATE の決まりが無く、2回目の［回答して完了］が 42501 で黙って失敗していた → 本人の行は直せる
--
-- 🚨 2026-10-30 からの Supabase の変更に合わせ、新しい表には GRANT を書く。新しい関数は anon から明示して外す

-- ───────── 1. 列 ─────────
alter table public.board_messages
  add column if not exists survey jsonb,
  add column if not exists survey_visibility text not null default 'sender',
  add column if not exists survey_onegai boolean not null default false;

do $$ begin
  alter table public.board_messages add constraint board_messages_survey_visibility_check
    check (survey_visibility in ('sender', 'respondents_count', 'respondents_named'));
exception when duplicate_object then null; end $$;

comment on column public.board_messages.survey is
  'アンケートの質問（{"v":1,"questions":[...]}）。お知らせの「✏️ 回答」だけ。形は board_survey_normalize で確かめ、トリガーが入れる';
comment on column public.board_messages.survey_visibility is
  '回答の見せ方：sender＝送った人と写しの人だけ／respondents_count＝回答した人どうし（数だけ）／respondents_named＝回答した人どうし（名前つき）';
comment on column public.board_messages.survey_onegai is
  '回答のあと「ご提案」で申請につなぐか（段2）。申請の依頼の権限がある人だけ・名前つきの見せ方とは同時に使えない';

alter table public.board_notice_templates add column if not exists survey jsonb;
do $$ begin
  alter table public.board_notice_templates add constraint board_notice_templates_survey_check
    check (survey is null or jsonb_typeof(survey) = 'object');
exception when duplicate_object then null; end $$;

-- ───────── 2. 回答の表 ─────────
create table if not exists public.board_survey_answers (
  message_id  uuid not null references public.board_messages(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  answers     jsonb not null,
  answered_at timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  edit_count  integer not null default 0,
  is_late     boolean not null default false,
  primary key (message_id, user_id)
);
alter table public.board_survey_answers enable row level security;
-- 読むのは本人の行だけ（ほかの人の回答は board_survey_results が見られる人にだけ返す）。書く決まりは作らない＝書くのは関数だけ
drop policy if exists board_survey_answers_select_own on public.board_survey_answers;
create policy board_survey_answers_select_own on public.board_survey_answers
  for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.board_survey_answers from anon, authenticated;
grant select on public.board_survey_answers to authenticated;
grant all on public.board_survey_answers to service_role;

-- ───────── 3. お知らせを送れる人（画面の canSendNotice と同じ決まり・1か所） ─────────
-- 管理者 または 設定が空（全員） または 本人の役職名が設定に入っている
create or replace function public.board_can_send_notice(p_user uuid)
returns boolean
language sql
stable security definer
set search_path = public
as $$
  select coalesce(
    exists (select 1 from auth.users u where u.id = p_user and (u.raw_app_meta_data ->> 'role') = 'admin')
    or not exists (
      select 1 from app_settings s
       where s.key = 'board_notice_send_roles' and jsonb_typeof(s.value) = 'array' and jsonb_array_length(s.value) > 0)
    or exists (
      select 1 from app_settings s
       cross join lateral jsonb_array_elements_text(s.value) v(role_name)
       join profiles p on p.id = p_user and p.role_title = v.role_name
       where s.key = 'board_notice_send_roles' and jsonb_typeof(s.value) = 'array'),
    false);
$$;
revoke execute on function public.board_can_send_notice(uuid) from public;
revoke execute on function public.board_can_send_notice(uuid) from anon;
revoke execute on function public.board_can_send_notice(uuid) from authenticated;
grant execute on function public.board_can_send_notice(uuid) to service_role;

-- ───────── 4. 質問の形を確かめて整える（id はここで振る） ─────────
-- 入力：{"v":1,"questions":[{"id"?,"kind","label","help"?,"required","options"?:[{"id"?,"label"}],"allow_other"?,"date_from"?,"date_to"?}]}
-- 🚨 画面（lib/boardSurvey）の決まりと同じ。片方だけ直さない
create or replace function public.board_survey_normalize(p_survey jsonb)
returns jsonb
language plpgsql
volatile   -- id を振る（gen_random_uuid）ので immutable にしない
set search_path = public
as $$
declare
  q jsonb; o jsonb;
  v_qs jsonb := '[]'::jsonb; v_opts jsonb;
  v_kind text; v_label text; v_help text; v_qid text; v_oid text; v_olabel text;
  v_qids text[] := '{}'; v_oids text[];
  v_from date; v_to date; v_n int := 0;
begin
  if p_survey is null or jsonb_typeof(p_survey) <> 'object' then raise exception 'アンケートの形が正しくありません' using errcode = '22023'; end if;
  if coalesce(p_survey ->> 'v', '1') <> '1' then raise exception 'アンケートの版が違います。画面を更新してください' using errcode = '22023'; end if;
  if jsonb_typeof(p_survey -> 'questions') <> 'array' then raise exception '質問がありません' using errcode = '22023'; end if;
  if jsonb_array_length(p_survey -> 'questions') = 0 then raise exception '質問を1つ以上作ってください' using errcode = '22023'; end if;
  if jsonb_array_length(p_survey -> 'questions') > 30 then raise exception '質問は30個までです' using errcode = '22023'; end if;

  for q in select value from jsonb_array_elements(p_survey -> 'questions') loop
    v_n := v_n + 1;
    if jsonb_typeof(q) <> 'object' then raise exception '%問目の形が正しくありません', v_n using errcode = '22023'; end if;
    v_kind := q ->> 'kind';
    if v_kind is null or v_kind not in ('single', 'multi', 'text', 'date') then raise exception '%問目の答え方が正しくありません', v_n using errcode = '22023'; end if;
    v_label := btrim(coalesce(q ->> 'label', ''));
    if v_label = '' then raise exception '%問目の質問の文がありません', v_n using errcode = '22023'; end if;
    if char_length(v_label) > 200 then raise exception '%問目の質問の文は200字までです', v_n using errcode = '22023'; end if;
    v_help := nullif(btrim(coalesce(q ->> 'help', '')), '');
    if char_length(coalesce(v_help, '')) > 500 then raise exception '%問目の説明は500字までです', v_n using errcode = '22023'; end if;

    v_qid := q ->> 'id';
    if v_qid is null or v_qid !~ '^[A-Za-z0-9_-]{1,40}$' or v_qid = any(v_qids) then v_qid := replace(gen_random_uuid()::text, '-', ''); end if;
    v_qids := v_qids || v_qid;

    v_opts := null; v_from := null; v_to := null;
    if v_kind in ('single', 'multi') then
      if jsonb_typeof(q -> 'options') <> 'array' or jsonb_array_length(q -> 'options') < 2 then
        raise exception '%問目の選択肢を2つ以上作ってください', v_n using errcode = '22023'; end if;
      if jsonb_array_length(q -> 'options') > 30 then raise exception '%問目の選択肢は30個までです', v_n using errcode = '22023'; end if;
      v_opts := '[]'::jsonb; v_oids := '{}';
      for o in select value from jsonb_array_elements(q -> 'options') loop
        v_olabel := btrim(coalesce(o ->> 'label', ''));
        if v_olabel = '' then raise exception '%問目に空の選択肢があります', v_n using errcode = '22023'; end if;
        if char_length(v_olabel) > 100 then raise exception '%問目の選択肢は100字までです', v_n using errcode = '22023'; end if;
        v_oid := o ->> 'id';
        if v_oid is null or v_oid !~ '^[A-Za-z0-9_-]{1,40}$' or v_oid = any(v_oids) or v_oid = '__other__' then
          v_oid := replace(gen_random_uuid()::text, '-', ''); end if;
        v_oids := v_oids || v_oid;
        v_opts := v_opts || jsonb_build_array(jsonb_build_object('id', v_oid, 'label', v_olabel));
      end loop;
    elsif v_kind = 'date' then
      begin
        v_from := nullif(q ->> 'date_from', '')::date;
        v_to := nullif(q ->> 'date_to', '')::date;
      exception when others then raise exception '%問目の日付の範囲が正しくありません', v_n using errcode = '22023';
      end;
      if v_from is not null and v_to is not null and v_from > v_to then raise exception '%問目の日付の範囲が逆です', v_n using errcode = '22023'; end if;
    end if;

    v_qs := v_qs || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'id', v_qid, 'kind', v_kind, 'label', v_label, 'help', v_help,
      'required', coalesce((q ->> 'required')::boolean, false),
      'options', v_opts,
      'allow_other', case when v_kind in ('single', 'multi') then coalesce((q ->> 'allow_other')::boolean, false) end,
      'date_from', v_from, 'date_to', v_to)));
  end loop;
  return jsonb_build_object('v', 1, 'questions', v_qs);
end;
$$;
revoke execute on function public.board_survey_normalize(jsonb) from public;
revoke execute on function public.board_survey_normalize(jsonb) from anon;
grant execute on function public.board_survey_normalize(jsonb) to authenticated, service_role;

-- ───────── 5. お知らせの見張り（送れる人・アンケートの決まり） ─────────
-- 🚨 auth.uid() は使わない（毎分のジョブ board_deliver には uid が無い）。判定は new.user_id で
create or replace function public.board_messages_survey_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_notice boolean := new.channel_id is null and new.parent_id is null;
  v_answers integer;
begin
  if tg_op = 'INSERT' then
    -- お知らせ送信権限（ふつうのお知らせにも効く・2026-10-29 ユーザー確定）。返信・グループ・DM は今までどおり
    if v_notice and not board_can_send_notice(new.user_id) then
      raise exception 'お知らせを送る権限がありません' using errcode = '42501';
    end if;
  end if;

  if tg_op = 'UPDATE'
     and new.survey is not distinct from old.survey
     and new.survey_visibility is not distinct from old.survey_visibility
     and new.survey_onegai is not distinct from old.survey_onegai
     and new.deadline_type is not distinct from old.deadline_type then
    return new;   -- アンケートに関係する列が変わっていない（届け・既読・本文の直しなど）
  end if;

  if new.survey is null then
    if tg_op = 'UPDATE' and old.survey is not null then
      select count(*) into v_answers from board_survey_answers where message_id = new.id;
      if v_answers > 0 then raise exception '回答が届いているため、質問は消せません' using errcode = '42501'; end if;
    end if;
    new.survey_visibility := 'sender';
    new.survey_onegai := false;
    return new;
  end if;

  if not v_notice then raise exception 'アンケートはお知らせでだけ使えます' using errcode = '22023'; end if;
  if new.deadline_type is distinct from 'answer' then raise exception 'アンケートは種別「回答」で送ってください' using errcode = '22023'; end if;
  if not user_has_feature_permission(new.user_id, 'board_survey') then
    raise exception 'アンケートを作る権限がありません' using errcode = '42501';
  end if;
  if new.survey_onegai then
    if not user_has_feature_permission(new.user_id, 'application_request') then
      raise exception '「ご提案」を使う権限がありません（申請の依頼の権限が要ります）' using errcode = '42501';
    end if;
    if new.survey_visibility = 'respondents_named' then
      raise exception '「ご提案」を使うアンケートでは、名前つきで回答を見せることはできません' using errcode = '22023';
    end if;
  end if;

  if tg_op = 'UPDATE' then
    if old.survey is null and old.status = 'sent' then
      raise exception '送ったお知らせに、あとから質問は足せません' using errcode = '22023';
    end if;
    -- 🚨 回答が1件でも届いたら、質問・見せ方・ご提案は変えない（答えの意味が変わる・見せ方を広げると漏れる）
    select count(*) into v_answers from board_survey_answers where message_id = new.id;
    if v_answers > 0 then
      raise exception '回答が届いているため、質問は直せません。直すときは取り消して出し直してください' using errcode = '42501';
    end if;
  end if;

  new.survey := board_survey_normalize(new.survey);
  -- 古い画面（質問票を出せない）にはこの文が「回答の説明」として出る。新しい画面では出さない
  new.answer_prompt := '最新の画面に更新してから回答してください（アンケート）';
  new.answer_location := null;
  new.answer_link := null;
  return new;
end;
$$;
revoke execute on function public.board_messages_survey_guard() from public;
revoke execute on function public.board_messages_survey_guard() from anon;
revoke execute on function public.board_messages_survey_guard() from authenticated;

drop trigger if exists trg_board_messages_survey_guard on public.board_messages;
create trigger trg_board_messages_survey_guard
  before insert or update on public.board_messages
  for each row execute function public.board_messages_survey_guard();

-- ───────── 6. 回答の行（board_confirmations）を見られる人・数 ─────────
create or replace function public.board_can_see_confirmations(p_message_id uuid)
returns boolean
language sql
stable security definer
set search_path = public
as $$
  select coalesce(public.is_admin(), false) or exists (
    select 1 from board_messages m
     where m.id = p_message_id
       and (
         m.user_id = auth.uid()
         or (m.cc_user_ids is not null and auth.uid()::text = any (m.cc_user_ids) and board_is_notice_cc_rep())
         or (m.channel_id is not null and exists (
               select 1 from board_channel_members bcm where bcm.channel_id = m.channel_id and bcm.user_id = auth.uid()))
       ));
$$;
revoke execute on function public.board_can_see_confirmations(uuid) from public;
revoke execute on function public.board_can_see_confirmations(uuid) from anon;
grant execute on function public.board_can_see_confirmations(uuid) to authenticated, service_role;

-- 「◯人/◯人」の数だけ（宛先の人にも出す）。返すのは、呼んだ人が開けるお知らせ・グループの投稿の分だけ
create or replace function public.board_confirm_counts(p_ids uuid[])
returns table (message_id uuid, done integer)
language sql
stable security definer
set search_path = public
as $$
  select m.id, (select count(*)::int from board_confirmations c where c.message_id = m.id)
    from board_messages m
   where m.id = any (p_ids)
     and auth.uid() is not null
     and (
       coalesce(public.is_admin(), false)
       or m.user_id = auth.uid()
       or (m.cc_user_ids is not null and auth.uid()::text = any (m.cc_user_ids))
       or exists (select 1 from board_message_recipients r where r.message_id = m.id and r.user_id = auth.uid())
       or (m.channel_id is not null and exists (
             select 1 from board_channel_members bcm where bcm.channel_id = m.channel_id and bcm.user_id = auth.uid()))
     );
$$;
revoke execute on function public.board_confirm_counts(uuid[]) from public;
revoke execute on function public.board_confirm_counts(uuid[]) from anon;
grant execute on function public.board_confirm_counts(uuid[]) to authenticated, service_role;

-- アンケートの回答は board_survey_answer の中（印あり）でだけ（古い画面の自由記述・直接の書き込みで「回答済み」にさせない）
create or replace function public.board_confirmations_survey_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1 from board_messages m where m.id = new.message_id and m.survey is not null)
     and coalesce(current_setting('app.survey_answer', true), '') <> 'on' then
    raise exception '最新の画面に更新してから回答してください' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function public.board_confirmations_survey_guard() from public;
revoke execute on function public.board_confirmations_survey_guard() from anon;
revoke execute on function public.board_confirmations_survey_guard() from authenticated;

drop trigger if exists trg_board_confirmations_survey_guard on public.board_confirmations;
create trigger trg_board_confirmations_survey_guard
  before insert or update on public.board_confirmations
  for each row execute function public.board_confirmations_survey_guard();

-- 本人の行は直せる（今の2回目の［回答して完了］が 42501 で黙って失敗していた）
drop policy if exists board_confirmations_update_own on public.board_confirmations;
create policy board_confirmations_update_own on public.board_confirmations
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));
-- 🚨 select を締めるのは画面を出す前でもよい（数は board_confirm_counts に移す）。古い画面では、宛先の人の「◯人/◯人」が自分の分だけになる（見た目だけ）
drop policy if exists board_confirmations_select on public.board_confirmations;
create policy board_confirmations_select on public.board_confirmations
  for select to authenticated
  using (user_id = (select auth.uid()) or public.board_can_see_confirmations(message_id));

-- ───────── 7. 回答する ─────────
-- p_answers：{質問の id: 値}。single＝{"choice":"<選択肢の id>|__other__","other":"..."}／multi＝{"choices":[...],"other":"..."}／text＝{"text":"..."}／date＝{"dates":["YYYY-MM-DD",...]}
create or replace function public.board_survey_answer(p_message_id uuid, p_answers jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
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
$$;
revoke execute on function public.board_survey_answer(uuid, jsonb) from public;
revoke execute on function public.board_survey_answer(uuid, jsonb) from anon;
grant execute on function public.board_survey_answer(uuid, jsonb) to authenticated, service_role;

-- ───────── 8. 回答を見る ─────────
-- 送った人・写しの代表者・管理者：全員の回答（名前・日時・直した回数・期限後）＋宛先
-- respondents_named：宛先で、自分が回答したあと＝全員の回答（名前つき・日時なし）
-- respondents_count：宛先で、自分が回答したあと＝選択肢・日付の数だけ（文字の回答は出さない）
create or replace function public.board_survey_results(p_message_id uuid)
returns jsonb
language plpgsql
stable security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  m board_messages;
  v_full boolean;
  v_answered boolean;
begin
  if v_uid is null then raise exception 'ログインが必要です' using errcode = '42501'; end if;
  select * into m from board_messages where id = p_message_id;
  if not found or m.survey is null then raise exception 'このお知らせはアンケートではありません' using errcode = '22023'; end if;

  v_full := coalesce(public.is_admin(), false) or m.user_id = v_uid
         or (m.cc_user_ids is not null and v_uid::text = any (m.cc_user_ids) and board_is_notice_cc_rep());
  if v_full then
    return jsonb_build_object(
      'mode', 'full',
      'recipients', coalesce((select jsonb_agg(r.user_id) from board_message_recipients r where r.message_id = m.id), '[]'::jsonb),
      'rows', coalesce((select jsonb_agg(jsonb_build_object(
                 'user_id', a.user_id, 'name', p.name, 'answers', a.answers,
                 'answered_at', a.answered_at, 'updated_at', a.updated_at, 'edit_count', a.edit_count, 'is_late', a.is_late)
               order by a.answered_at)
               from board_survey_answers a left join profiles p on p.id = a.user_id
              where a.message_id = m.id), '[]'::jsonb));
  end if;

  v_answered := exists (select 1 from board_survey_answers a where a.message_id = m.id and a.user_id = v_uid);
  if m.survey_visibility = 'sender' or not v_answered
     or not exists (select 1 from board_message_recipients r where r.message_id = m.id and r.user_id = v_uid) then
    raise exception '回答の一覧を見る権限がありません' using errcode = '42501';
  end if;

  if m.survey_visibility = 'respondents_named' then
    return jsonb_build_object(
      'mode', 'named',
      'rows', coalesce((select jsonb_agg(jsonb_build_object('user_id', a.user_id, 'name', p.name, 'answers', a.answers) order by a.answered_at)
               from board_survey_answers a left join profiles p on p.id = a.user_id
              where a.message_id = m.id), '[]'::jsonb));
  end if;

  -- 数だけ：選択肢の id ごと・日付ごとの数。文字の回答・その他の中身は出さない
  return jsonb_build_object(
    'mode', 'count',
    'respondents', (select count(*) from board_survey_answers a where a.message_id = m.id),
    'counts', coalesce((
      select jsonb_object_agg(qid, cnt) from (
        select x.qid, jsonb_object_agg(x.val, x.n) as cnt from (
          select q ->> 'id' as qid, v.val, count(*) as n
            from jsonb_array_elements(m.survey -> 'questions') q
            join board_survey_answers a on a.message_id = m.id
            cross join lateral (
              select a.answers -> (q ->> 'id') ->> 'choice' as val where q ->> 'kind' = 'single'
              union all
              select c from jsonb_array_elements_text(coalesce(a.answers -> (q ->> 'id') -> 'choices', '[]'::jsonb)) c where q ->> 'kind' = 'multi'
              union all
              select d from jsonb_array_elements_text(coalesce(a.answers -> (q ->> 'id') -> 'dates', '[]'::jsonb)) d where q ->> 'kind' = 'date'
            ) v
           where v.val is not null
           group by 1, 2
        ) x group by x.qid
      ) y), '{}'::jsonb));
end;
$$;
revoke execute on function public.board_survey_results(uuid) from public;
revoke execute on function public.board_survey_results(uuid) from anon;
grant execute on function public.board_survey_results(uuid) to authenticated, service_role;

-- ───────── 9. board_post（本番の実定義 2026-10-29 から・insert の列にアンケートの3つを足しただけ） ─────────
create or replace function public.board_post(p_id uuid, p_msg jsonb, p_recipients uuid[] default null::uuid[], p_hold boolean default true, p_batch uuid default null::uuid)
 returns jsonb
 language plpgsql
 set search_path to 'public'
as $function$
declare
  v_uid   uuid := auth.uid();
  r       public.board_messages;
  v_ex    public.board_messages;
  v_sched timestamptz;
  v_n     integer;
begin
  if v_uid is null then raise exception 'ログインが必要です' using errcode = '42501'; end if;
  if p_id is null then raise exception '送る番号がありません' using errcode = '22023'; end if;

  -- 同じ番号がもうある＝押し直し・送り直し。今の状態を返すだけ（2件にしない）
  select * into v_ex from board_messages where id = p_id;
  if found then
    if v_ex.user_id <> v_uid then raise exception 'この番号は使えません' using errcode = '42501'; end if;
    return jsonb_build_object('id', v_ex.id,
      'state', case when v_ex.status = 'sent' then 'sent' when v_ex.send_hold then 'held' else 'scheduled' end,
      'scheduled_at', v_ex.scheduled_at, 'existed', true);
  end if;

  r := jsonb_populate_record(null::public.board_messages, p_msg);
  if coalesce(btrim(r.body), '') = '' then raise exception '本文がありません' using errcode = '22023'; end if;
  v_sched := case when r.parent_id is null then r.scheduled_at else null end;   -- 返信は予約できない

  if r.channel_id is null and r.parent_id is null then
    if coalesce(btrim(r.subject), '') = '' then raise exception '件名がありません' using errcode = '22023'; end if;
    if coalesce(cardinality(p_recipients), 0) = 0 then raise exception '宛先がありません' using errcode = '22023'; end if;
  elsif r.channel_id is null then
    if coalesce(cardinality(p_recipients), 0) <> 1 then raise exception '返信の相手がありません' using errcode = '22023'; end if;
    if not board_reply_party(r.parent_id, p_recipients[1]) then
      raise exception '返信の相手が、このお知らせの関係者ではありません' using errcode = '42501';
    end if;
  end if;

  -- 🚨 読み書きの決まり（RLS）はそのまま効く（invoker）。送れない人・入っていないグループは止まる
  -- 🚨 アンケート（survey）の確かめ・整えは board_messages のトリガー（board_messages_survey_guard）
  insert into board_messages (
    id, channel_id, parent_id, user_id, body, subject, title,
    deadline, deadline_type, requires_confirmation,
    answer_prompt, answer_location, answer_link, allow_reply,
    cc_user_ids, recipient_presets, recipient_extra_ids, broadcast_recipients,
    status, scheduled_at, send_hold, push_urgent, send_batch,
    survey, survey_visibility, survey_onegai)
  values (
    p_id, r.channel_id, r.parent_id, v_uid, btrim(r.body), nullif(btrim(r.subject), ''), nullif(btrim(r.title), ''),
    r.deadline, r.deadline_type, coalesce(r.requires_confirmation, false),
    r.answer_prompt, r.answer_location, r.answer_link, coalesce(r.allow_reply, false),
    coalesce(r.cc_user_ids, '{}'::text[]), r.recipient_presets, r.recipient_extra_ids, r.broadcast_recipients,
    'scheduled',
    case when v_sched is not null then v_sched
         when p_hold then clock_timestamp() + interval '10 seconds'
         else clock_timestamp() end,
    v_sched is null,
    coalesce(r.push_urgent, false),
    p_batch,
    r.survey, coalesce(r.survey_visibility, 'sender'), coalesce(r.survey_onegai, false));

  if r.channel_id is null then
    insert into board_message_recipients (message_id, user_id)
    select p_id, u from (select distinct unnest(p_recipients) as u) x where u is not null;
  end if;

  if v_sched is not null then
    return jsonb_build_object('id', p_id, 'state', 'scheduled', 'scheduled_at', v_sched, 'existed', false);
  end if;
  if not p_hold then
    v_n := board_release_hold(p_id, null);
    return jsonb_build_object('id', p_id, 'state', case when v_n > 0 then 'sent' else 'held' end, 'scheduled_at', null, 'existed', false);
  end if;
  return jsonb_build_object('id', p_id, 'state', 'held',
    'scheduled_at', (select scheduled_at from board_messages where id = p_id), 'existed', false);
end;
$function$;

-- ───────── 10. 権限の行（最初はマネージャー・社長・管理者だけ・2026-10-29 ユーザー確定） ─────────
insert into public.feature_permissions (role_id, feature_key, enabled)
select r.id, 'board_survey', coalesce(r.is_manager_plus, false)
  from public.roles r
 where not exists (select 1 from public.feature_permissions f where f.role_id = r.id and f.feature_key = 'board_survey');
