-- 有休奨励日の休みは「奨励日の回答」から出してもらう（2026-10-19 ユーザー確定・計画 docs/計画-有休奨励日の申請止め.md・2体でレビュー）
--
-- ・止める申請：休暇申請の 有給休暇／バースデー休暇（有給）（昔の '有給' も）、残業申請の 時間外調整休（chosei_off）
-- ・止める日：年間カレンダー（company_calendar.kind='work_on_closed_encouraged'）の奨励日
-- ・止める相手：その日の回答の受付（paid_leave_encouragement_days）が
--     無い → 正社員全員（止めない人を除く）
--     ある → その受付の対象者だけ（同じ日に受付が2件あれば合わせて見る）
-- ・止めない人：app_settings 'encouragement_exempt' { user_ids: [...] }（管理画面で選ぶ・初めは役員と共用のアカウントの4件）
-- ・通す：奨励日の回答・管理画面の回答の修正（関数の中で app.enc_answer の印を立てる）／管理者・社長の操作／ログインなし（cron・service）
--   🚨 休暇の reason（'【有給奨励日】'）では通さない：本人が理由欄に同じ文字を書けばすり抜けられるため（2026-10-19 レビューで指摘）
-- ・文は DB で作る（画面は出すだけ）。止めたときは今の重なり止めと同じ 'DAYOFF_CONFLICT|<文>'（画面3か所がそのまま文を出す）
--   奨励日の止めを先に見て、重なり止めはそのあと（原因の側の文を先に出す）
-- ・休暇のトリガーは「種類を変えたとき（leave_type）」「理由を変えたとき（reason）」も見る（前は status・leave_dates だけで、
--   管理画面の「種類を変えて受理」や本人の直しで 慶弔→有給 にすると通ってしまった）
-- ・回答：選択肢5「ほかの休みを申請する（慶弔・振替・欠勤）」（休暇は作らない・内容は必須）。出勤のチェックを記録に残す（working）。
--   その日にほかの休暇（取消・差し戻し以外）がもうあるときは、休暇を作る回答を断る（休暇が2件になるのを防ぐ）
-- ・管理画面の回答の修正は admin_set_encouragement_answer 1本（前は画面から delete → insert で、途中で止まると休暇だけ消えた・
--   選択肢4で出勤でも「その他」の休暇を作っていた）
-- 🚨 関数は本番の実定義（2026-10-19 pg_get_functiondef）から起こした。変えたところに「2026-10-19 奨励日」と書いた

-- ── 止めない人（初めの4件：役員2名・共用のアカウント2つ） ─────────────────────
insert into public.app_settings (key, value, updated_at)
values ('encouragement_exempt', jsonb_build_object('user_ids', jsonb_build_array(
  '06648967-527f-41e9-9662-281909e42296',
  '38e1df30-a40a-486e-a79f-4af89604157b',
  'aad2b6cf-2e62-4c8b-9e36-40922c48c13f',
  '705a09b8-87bd-45f8-811b-144bbb5dd143')), now())
on conflict (key) do nothing;

-- ── 回答の記録：選択肢5・出勤のチェック ─────────────────────────────────
alter table public.paid_leave_encouragement_responses add column if not exists working boolean;
comment on column public.paid_leave_encouragement_responses.working is
  '選択肢4で「出勤する」か（2026-10-19〜）。null＝それより前の回答（選択肢4で休暇「その他」を作ったものがある）';
alter table public.paid_leave_encouragement_responses drop constraint if exists paid_leave_encouragement_responses_choice_check;
alter table public.paid_leave_encouragement_responses add constraint paid_leave_encouragement_responses_choice_check
  check (choice >= 1 and choice <= 5);

-- ── 止める種類か ───────────────────────────────────────────────────────────
create or replace function public.encouragement_blocked_kind(p_side text, p_leave_type text, p_ot_types text[])
returns boolean
language sql
immutable
set search_path to 'public'
as $$
  select case p_side
    when 'leave' then coalesce(p_leave_type, '') in ('有給休暇', 'バースデー休暇（有給）', '有給')
    when 'overtime' then coalesce('chosei_off' = any(p_ot_types), false)
    else false end;
$$;

-- ── 止めるなら文を返す（止めないなら null） ───────────────────────────────
create or replace function public.encouragement_block_message(p_user uuid, p_date date)
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v_has_day boolean;
  v_target boolean;
  v_answered boolean;
  v_md text := public.jp_md_dow(p_date);
begin
  if p_user is null or p_date is null then return null; end if;
  -- 奨励日の回答・管理画面の回答の修正（関数の中で印を立てる）
  if current_setting('app.enc_answer', true) = '1' then return null; end if;
  -- cron・service（ログインなし）／管理者・社長の操作（例外の対応）
  if auth.uid() is null or public.is_admin() or public.acts_as_is('president') then return null; end if;
  -- 年間カレンダーの奨励日か
  if not exists (select 1 from company_calendar c where c.date = p_date and c.kind = 'work_on_closed_encouraged') then
    return null;
  end if;
  -- 止めない人（役員など）
  if exists (
    select 1 from app_settings s
    where s.key = 'encouragement_exempt'
      and coalesce(s.value -> 'user_ids', '[]'::jsonb) ? p_user::text
  ) then
    return null;
  end if;

  select exists (select 1 from paid_leave_encouragement_days d where d.target_date = p_date) into v_has_day;
  if v_has_day then
    select exists (
      select 1 from paid_leave_encouragement_targets t
      join paid_leave_encouragement_days d on d.id = t.encouragement_day_id
      where d.target_date = p_date and t.user_id = p_user
    ) into v_target;
    if not v_target then return null; end if;
    select exists (
      select 1 from paid_leave_encouragement_responses r
      join paid_leave_encouragement_days d on d.id = r.encouragement_day_id
      where d.target_date = p_date and r.user_id = p_user
    ) into v_answered;
    if v_answered then
      return v_md || 'の有休奨励日は回答済みです。内容を変える場合は、経理へご連絡ください。';
    end if;
    return v_md || 'は有休奨励日のため、この日の有給休暇・時間外調整休はここでは申請できません。「有休奨励日の回答」から回答してください。';
  end if;

  -- 受付の前：正社員だけ
  if not exists (select 1 from profiles p where p.id = p_user and p.employment_type = '正社員') then
    return null;
  end if;
  return v_md || 'は有休奨励日のため、この日の有給休暇・時間外調整休はここでは申請できません。回答のお知らせが届いたら、「有休奨励日の回答」から回答してください。お知らせが届かない場合は、経理へご相談ください。';
end;
$$;

-- ── 休暇のトリガー（本番の実定義から・2026-10-19 奨励日：奨励日の止めを先に・種類と理由の変更も見る） ──
CREATE OR REPLACE FUNCTION public.enforce_day_off_conflict_leave()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_new text;
  v_verb text;
  v_msg text;
  d text;
begin
  if new.status in ('cancelled', 'rejected') then return new; end if;
  if new.leave_dates is null then return new; end if;
  -- 2026-10-19 奨励日：種類（leave_type）・理由（reason）が変わったときも見る（日付も種類も同じ更新＝受理などは素通り）
  if tg_op = 'UPDATE'
     and old.status not in ('cancelled', 'rejected')
     and old.leave_dates is not distinct from new.leave_dates
     and old.leave_type is not distinct from new.leave_type
     and old.reason is not distinct from new.reason then
    return new;
  end if;
  if coalesce(new.reason, '') = '【有給奨励日】' then
    v_new := '有休奨励日の休み（' || public.day_off_leave_label(new.leave_type) || '）';
    v_verb := '回答';
  else
    v_new := '休暇申請（' || public.day_off_leave_label(new.leave_type) || '）';
    v_verb := '申請';
  end if;
  for d in select jsonb_array_elements_text(new.leave_dates::jsonb) loop
    -- 2026-10-19 奨励日：有給休暇・バースデー休暇は「奨励日の回答」から（先に見る）
    if public.encouragement_blocked_kind('leave', new.leave_type, null) then
      v_msg := public.encouragement_block_message(new.user_id, d::date);
      if v_msg is not null then raise exception 'DAYOFF_CONFLICT|%', v_msg; end if;
    end if;
    v_msg := public.day_off_conflict_message(new.user_id, d::date, 'leave', v_new, v_verb);
    if v_msg is not null then raise exception 'DAYOFF_CONFLICT|%', v_msg; end if;
  end loop;
  return new;
end;
$function$;

drop trigger if exists trg_day_off_conflict_leave on public.leave_requests;
create trigger trg_day_off_conflict_leave
  before insert or update of status, leave_dates, leave_type, reason on public.leave_requests
  for each row execute function public.enforce_day_off_conflict_leave();

-- ── 残業のトリガー（本番の実定義から・2026-10-19 奨励日：時間外調整休は奨励日の止めを先に） ──
CREATE OR REPLACE FUNCTION public.enforce_day_off_conflict_overtime()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_label text;
  v_msg text;
begin
  if new.entry_type is distinct from 'manual' then return new; end if;
  if new.status in ('cancelled', 'rejected', 'returned') then return new; end if;
  v_label := public.day_off_ot_label(new.application_types);
  if v_label is null then return new; end if;
  if tg_op = 'UPDATE'
     and old.status not in ('cancelled', 'rejected', 'returned')
     and old.work_date = new.work_date
     and old.application_types is not distinct from new.application_types then
    return new;
  end if;
  -- 2026-10-19 奨励日：時間外調整休は「奨励日の回答」から（先に見る）
  if public.encouragement_blocked_kind('overtime', null, new.application_types) then
    v_msg := public.encouragement_block_message(new.applicant_id, new.work_date);
    if v_msg is not null then raise exception 'DAYOFF_CONFLICT|%', v_msg; end if;
  end if;
  v_msg := public.day_off_conflict_message(new.applicant_id, new.work_date, 'overtime', v_label, '申請');
  if v_msg is not null then raise exception 'DAYOFF_CONFLICT|%', v_msg; end if;
  return new;
end;
$function$;

-- ── 送る前の確かめ（本番の実定義から・2026-10-19 奨励日：奨励日の止めを先に） ──
CREATE OR REPLACE FUNCTION public.my_day_off_conflict(p_dates date[], p_side text, p_kind text, p_encouragement boolean DEFAULT false)
 RETURNS text
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  d date;
  v_msg text;
  v_new text;
  v_verb text;
  v_enc boolean;
begin
  if v_uid is null or p_side not in ('overtime', 'leave') then return null; end if;
  -- 2026-10-19 奨励日：奨励日の回答そのものは止めない（回答の画面からの確かめ）
  v_enc := not p_encouragement and (
    (p_side = 'leave' and public.encouragement_blocked_kind('leave', p_kind, null))
    or (p_side = 'overtime' and public.encouragement_blocked_kind('overtime', null, array[p_kind])));
  if p_side = 'overtime' then
    v_new := public.day_off_ot_label(array[p_kind]); v_verb := '申請';
    if v_new is null then return null; end if;
  elsif p_encouragement then
    v_new := '有休奨励日の休み（' || public.day_off_leave_label(p_kind) || '）'; v_verb := '回答';
  else
    v_new := '休暇申請（' || public.day_off_leave_label(p_kind) || '）'; v_verb := '申請';
  end if;
  foreach d in array coalesce(p_dates, '{}') loop
    if v_enc then
      v_msg := public.encouragement_block_message(v_uid, d);
      if v_msg is not null then return v_msg; end if;
    end if;
    v_msg := public.day_off_conflict_message(v_uid, d, p_side, v_new, v_verb);
    if v_msg is not null then return v_msg; end if;
  end loop;
  return null;
end;
$function$;

-- ── 回答から作る休暇の中身（回答・管理画面の修正の両方が使う） ──────────────
create or replace function public.encouragement_leave_spec(p_choice integer, p_note text, p_working boolean,
  out leave_type text, out leave_type_other text)
language sql
immutable
set search_path to 'public'
as $$
  -- 1 有休／2 調整休／3 定休日／4 その他：出勤するなら作らない（出勤のチェックが無い昔の回答は「その他」の休暇）／5 ほかの休み：作らない
  select
    case
      when p_choice = 1 then '有給休暇'
      when p_choice = 2 then '調整休'
      when p_choice = 3 then 'その他'
      when p_choice = 4 and not coalesce(p_working, false) then 'その他'
      else null end,
    case
      when p_choice = 3 then '定休日'
      when p_choice = 4 and not coalesce(p_working, false) then coalesce(nullif(btrim(coalesce(p_note, '')), ''), 'その他')
      else null end;
$$;

-- ── 奨励日の回答（本番の実定義から・2026-10-19 奨励日：選択肢5・出勤の記録・休暇の2重を断る・印を立てる） ──
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
    perform set_config('app.enc_answer', '', true);
  end if;

  return query select true, null::text;
end;
$function$;

-- ── 管理画面の回答の修正（管理者だけ・1回でまとめて直す） ─────────────────────
create or replace function public.admin_set_encouragement_answer(p_day_id uuid, p_user_id uuid, p_choice integer,
  p_note text default null, p_working boolean default false)
returns table(ok boolean, reason text)
language plpgsql
security definer
set search_path to 'public'
as $$
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
    insert into leave_requests (
      user_id, leave_type, leave_type_other, leave_dates, start_date, end_date,
      purpose, reason, status, current_approver
    ) values (
      p_user_id, v_leave_type, v_type_other,
      to_json(array[to_char(v_target_date, 'YYYY-MM-DD')])::text,
      v_target_date, v_target_date,
      '有給奨励日', '【有給奨励日】', 'approved', 'none'
    );
  end if;
  perform set_config('app.enc_answer', '', true);

  return query select true, null::text;
end;
$$;

-- ── 実行の権限 ─────────────────────────────────────────────────────────────
revoke all on function public.encouragement_blocked_kind(text, text, text[]) from public;
revoke all on function public.encouragement_blocked_kind(text, text, text[]) from anon;
revoke all on function public.encouragement_block_message(uuid, date) from public;
revoke all on function public.encouragement_block_message(uuid, date) from anon, authenticated;
revoke all on function public.encouragement_leave_spec(integer, text, boolean) from public;
revoke all on function public.encouragement_leave_spec(integer, text, boolean) from anon;
revoke all on function public.admin_set_encouragement_answer(uuid, uuid, integer, text, boolean) from public;
revoke all on function public.admin_set_encouragement_answer(uuid, uuid, integer, text, boolean) from anon;
grant execute on function public.admin_set_encouragement_answer(uuid, uuid, integer, text, boolean) to authenticated;
