-- ============================================================
-- 2026-09-25  シフト調整：案を何通りも作れる／「確認した」／意見の期限（1段目＝DBだけ・いまの画面は変わらない）
-- ============================================================
-- 仕様は docs/計画-シフト調整.md §6-2（ユーザーと一問一答・UI/UX とエンジニアの2体レビュー）。
--
-- 【作るもの】
--   ① 表の手直し：shift_adjust_plans に 番号・担当・確認する方へのひとこと・更新日時・確認のやり直しの記録・期限の知らせ済みの印
--      shift_adjust_slots に plan_seq（番号は付け直さない＝欠番のまま）
--   ② 直接の書き込みを止める（plans / plan_reviews の INSERT の許可を外し、anon・authenticated の書き込み権限を外す）
--      🚨 2026-09-25 実測：作った本人が自分の案に「確認した」を入れられる許可が付いていた（0件・画面は未使用）
--   ③ 関数5つ（すべて SECURITY DEFINER・書き込みはここからだけ）
--      shift_adjust_plan_create / _update / _delete / _review / _unreview
--   ④ 決定・休みの取消・日の経過・「現行シフトで対応」で案を消すトリガー（いまの「案を保存」のトリガーは触らない）
--   ⑤ 通知設定の行（shift_adjust:plan_created / shift_adjust:plan_due）。🚨 行が無いと管理画面から止められない
--
-- 【決めたこと（抜粋）】
--   ・直す・消すは作った本人だけ。消すことだけは管理者も可
--   ・案が持つのは 人・時間・校（assignments）と「確認する方へ」（note）だけ。
--     🚨 勤怠に登録／残業申請を依頼 のチェックと「出勤する方へのメモ」は決定のときに入れる（案に入れると本人に届く恐れ）
--   ・確認できるのは確認の権限がある人（作った本人・休む本人は除く）。作った人が直したら確認は全部消える
--   ・未調整の日に案を作ったら「調整中」へ
--   ・意見の期限を付けた案のときだけ、確認の権限がある同じチームの人へ知らせる（ベル＋スマホ）
--   ・相談の欄に「作った・直した・消した」を自動で残す（決定は画面から残す）
--
-- 🚨 いまの shift_adjust_save_plan と saved_plans は触らない（新しい画面を出すまで今の画面が使う）。たたむのは最後の段
-- 🚨 戻り値の名前は表の列名と重ねない（out_ を付ける。2026-09-04 に 42702 で繰り上げが全部失敗した）
-- 🚨 新しい関数は public と anon から実行を外し、authenticated にだけ許す

-- ------------------------------------------------------------
-- ① 表の手直し
-- ------------------------------------------------------------
alter table public.shift_adjust_slots
  add column if not exists plan_seq int not null default 0;

alter table public.shift_adjust_plans drop constraint if exists shift_adjust_plans_body_check;
alter table public.shift_adjust_plans alter column body drop not null;   -- 使わない列（最初の設計の名残）
alter table public.shift_adjust_plans
  add column if not exists plan_no int,
  add column if not exists assignments jsonb not null default '[]'::jsonb,
  add column if not exists note text,
  add column if not exists updated_at timestamptz not null default now(),
  add column if not exists reviews_reset_at timestamptz,
  add column if not exists reviews_reset_count int,
  add column if not exists expired_notified_at timestamptz;

create unique index if not exists uq_shift_adjust_plans_slot_no
  on public.shift_adjust_plans (slot_id, plan_no);
create index if not exists idx_shift_adjust_plans_due
  on public.shift_adjust_plans (review_due_at) where expired_notified_at is null and review_due_at is not null;

comment on column public.shift_adjust_plans.note is '確認する方へのひとこと（出勤する方には届かない）';
comment on column public.shift_adjust_plans.reviews_reset_count is '作った人が直したときに消えた確認の人数（「前回 ◯人」の表示用）';

-- ------------------------------------------------------------
-- ② 直接の書き込みを止める（読む許可はそのまま）
-- ------------------------------------------------------------
drop policy if exists shift_adjust_plans_insert on public.shift_adjust_plans;
drop policy if exists shift_adjust_plan_reviews_insert on public.shift_adjust_plan_reviews;
revoke insert, update, delete on public.shift_adjust_plans from anon, authenticated;
revoke insert, update, delete on public.shift_adjust_plan_reviews from anon, authenticated;
revoke select on public.shift_adjust_plans from anon;
revoke select on public.shift_adjust_plan_reviews from anon;

-- ------------------------------------------------------------
-- 共通：日付の見出し（例 9/30（火））
-- ------------------------------------------------------------
create or replace function public.shift_adjust_date_label(p_date date)
returns text
language sql
immutable
set search_path = public
as $$
  select to_char(p_date, 'FMMM/FMDD') || '（' || (array['日','月','火','水','木','金','土'])[extract(dow from p_date)::int + 1] || '）';
$$;
revoke execute on function public.shift_adjust_date_label(date) from public;
revoke execute on function public.shift_adjust_date_label(date) from anon;
grant execute on function public.shift_adjust_date_label(date) to authenticated;

-- ------------------------------------------------------------
-- 共通：案が出たことを知らせる（意見の期限を付けた案のときだけ呼ぶ）
-- 宛先＝通知一覧「シフト調整の案」の役職 × 同じチーム（毎朝のまとめと同じ resolve_role_recipients）
--       × 確認と見る権限 − 作った本人（休む本人は resolve_role_recipients が外す）
-- 🚨 失敗しても案の保存は止めない（呼ぶ側で例外を受ける）
-- ------------------------------------------------------------
create or replace function public.shift_adjust_notify_plan_created(p_plan_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan   shift_adjust_plans%rowtype;
  v_slot   shift_adjust_slots%rowtype;
  v_on     boolean;
  v_rcp_t  text;
  v_rcp    jsonb;
  v_name   text;
  v_sent   int := 0;
  r        record;
begin
  select * into v_plan from shift_adjust_plans where id = p_plan_id;
  if not found or v_plan.review_due_at is null then return 0; end if;
  select * into v_slot from shift_adjust_slots where id = v_plan.slot_id;
  if not found then return 0; end if;

  select ns.enabled, ns.recipient into v_on, v_rcp_t
    from notification_settings ns
   where ns.event_key = 'shift_adjust:plan_created' and ns.channel = 'site';
  if v_on is false then return 0; end if;
  begin
    v_rcp := coalesce(nullif(v_rcp_t, '')::jsonb, '{}'::jsonb);
  exception when others then
    v_rcp := '{}'::jsonb;
  end;

  select coalesce(name, '') into v_name from profiles where id = v_slot.target_user_id;

  for r in
    select rid as user_id
      from public.resolve_role_recipients(v_slot.target_user_id, v_rcp) rid
     where rid <> v_plan.created_by
       and public.user_has_feature_permission(rid, 'shift_adjust_view')
       and public.user_has_feature_permission(rid, 'shift_adjust_review')
  loop
    insert into notifications (user_id, message, sub_message, source_type, event_key, reference_id)
    values (
      r.user_id,
      '🔁 ' || public.shift_adjust_date_label(v_slot.target_date) || 'のシフト調整に案が出ました',
      v_name || 'さんの休み・案' || v_plan.plan_no::text || '・意見の期限 '
        || to_char(v_plan.review_due_at at time zone 'Asia/Tokyo', 'FMMM/FMDD HH24:MI'),
      'shift_adjust:plan_created',
      'shift_adjust:plan_created',
      v_slot.id
    );
    v_sent := v_sent + 1;
  end loop;
  return v_sent;
end $$;
revoke execute on function public.shift_adjust_notify_plan_created(uuid) from public;
revoke execute on function public.shift_adjust_notify_plan_created(uuid) from anon;
revoke execute on function public.shift_adjust_notify_plan_created(uuid) from authenticated;   -- 下の関数の中からだけ呼ぶ

-- ------------------------------------------------------------
-- ③-1 案を作る
-- ------------------------------------------------------------
create or replace function public.shift_adjust_plan_create(
  p_slot_id uuid,
  p_assignments jsonb,
  p_note text,
  p_review_due_at timestamptz,
  p_summary text
)
returns table(ok boolean, reason text, out_plan_id uuid, out_plan_no int, out_updated_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_slot shift_adjust_slots%rowtype;
  v_no   int;
  v_id   uuid;
  v_now  timestamptz := now();
begin
  if not (public.has_feature_permission('shift_adjust_plan') and public.has_feature_permission('shift_adjust_view')) then
    return query select false, '案を作る権限がありません（管理画面の「権限管理」で設定します）'::text, null::uuid, null::int, null::timestamptz;
    return;
  end if;
  if p_assignments is null or jsonb_typeof(p_assignments) <> 'array' then
    return query select false, '案の形が正しくありません'::text, null::uuid, null::int, null::timestamptz;
    return;
  end if;
  if p_review_due_at is not null and p_review_due_at <= v_now then
    return query select false, '意見の期限は、いまより後の日時にしてください'::text, null::uuid, null::int, null::timestamptz;
    return;
  end if;

  select * into v_slot from shift_adjust_slots s where s.id = p_slot_id for update;
  if not found then
    return query select false, 'この調整の場は見つかりません'::text, null::uuid, null::int, null::timestamptz;
    return;
  end if;
  if v_slot.target_user_id = auth.uid() then
    return query select false, '自分の休みの調整は、この画面からは変えられません'::text, null::uuid, null::int, null::timestamptz;
    return;
  end if;
  if v_slot.status not in ('pending', 'working') then
    return query select false, 'この場はもう決まっているか、閉じています。案は作れません'::text, null::uuid, null::int, null::timestamptz;
    return;
  end if;

  -- 番号は場ごとに数え上げる。🚨 付け直さない（消した番号は二度と使わない）
  update shift_adjust_slots s set plan_seq = s.plan_seq + 1 where s.id = p_slot_id
  returning s.plan_seq into v_no;

  insert into shift_adjust_plans (slot_id, created_by, plan_no, assignments, note, review_due_at, created_at, updated_at)
  values (p_slot_id, auth.uid(), v_no, p_assignments, nullif(btrim(coalesce(p_note, '')), ''), p_review_due_at, v_now, v_now)
  returning id into v_id;

  -- 未調整の日に案を作ったら「調整中」へ（出勤のお願いを送ったときと同じ）
  if v_slot.status = 'pending' then
    update shift_adjust_slots s set status = 'working', updated_at = v_now where s.id = p_slot_id;
  end if;

  insert into shift_adjust_comments (slot_id, user_id, body)
  values (p_slot_id, auth.uid(),
          '案' || v_no::text || 'を作りました' || case when coalesce(p_summary, '') <> '' then '：' || p_summary else '' end);

  -- 意見の期限を付けた案のときだけ知らせる。🚨 失敗しても案は作れたことにする
  if p_review_due_at is not null then
    begin
      perform public.shift_adjust_notify_plan_created(v_id);
    exception when others then
      raise warning '[shift_adjust_plan_create] 案の知らせを送れませんでした: %', sqlerrm;
    end;
  end if;

  return query select true, ''::text, v_id, v_no, v_now;
end $$;
revoke execute on function public.shift_adjust_plan_create(uuid, jsonb, text, timestamptz, text) from public;
revoke execute on function public.shift_adjust_plan_create(uuid, jsonb, text, timestamptz, text) from anon;
grant execute on function public.shift_adjust_plan_create(uuid, jsonb, text, timestamptz, text) to authenticated;

-- ------------------------------------------------------------
-- ③-2 案を直す（作った本人だけ）。確認は全部消える。期限を延ばしたら知らせ済みの印を戻す
-- ------------------------------------------------------------
create or replace function public.shift_adjust_plan_update(
  p_plan_id uuid,
  p_assignments jsonb,
  p_note text,
  p_review_due_at timestamptz,
  p_summary text,
  p_expected_updated_at timestamptz
)
returns table(ok boolean, reason text, out_updated_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan    shift_adjust_plans%rowtype;
  v_slot    shift_adjust_slots%rowtype;
  v_slot_id uuid;
  v_now     timestamptz := now();
  v_cleared int := 0;
  v_newly_due boolean;
begin
  if not (public.has_feature_permission('shift_adjust_plan') and public.has_feature_permission('shift_adjust_view')) then
    return query select false, '案を作る権限がありません（管理画面の「権限管理」で設定します）'::text, null::timestamptz;
    return;
  end if;
  if p_assignments is null or jsonb_typeof(p_assignments) <> 'array' then
    return query select false, '案の形が正しくありません'::text, null::timestamptz;
    return;
  end if;

  select pl.slot_id into v_slot_id from shift_adjust_plans pl where pl.id = p_plan_id;
  if v_slot_id is null then
    return query select false, 'この案は見つかりません（消されたか、決定で片付いた可能性があります）'::text, null::timestamptz;
    return;
  end if;
  -- 🚨 押さえる順番は 場 → 案（ほかの関数と同じ順にして、行き詰まりを防ぐ）
  select * into v_slot from shift_adjust_slots s where s.id = v_slot_id for update;
  select * into v_plan from shift_adjust_plans pl where pl.id = p_plan_id for update;
  if not found then
    return query select false, 'この案は見つかりません（消されたか、決定で片付いた可能性があります）'::text, null::timestamptz;
    return;
  end if;
  if v_plan.created_by is distinct from auth.uid() then
    return query select false, '案を直せるのは、作った本人だけです'::text, null::timestamptz;
    return;
  end if;
  if v_slot.target_user_id = auth.uid() then
    return query select false, '自分の休みの調整は、この画面からは変えられません'::text, null::timestamptz;
    return;
  end if;
  if v_slot.status not in ('pending', 'working') then
    return query select false, 'この場はもう決まっているか、閉じています。案は直せません'::text, null::timestamptz;
    return;
  end if;
  if v_plan.updated_at is distinct from p_expected_updated_at then
    return query select false, 'conflict'::text, v_plan.updated_at;
    return;
  end if;
  if p_review_due_at is not null and p_review_due_at <= v_now
     and p_review_due_at is distinct from v_plan.review_due_at then
    return query select false, '意見の期限は、いまより後の日時にしてください'::text, null::timestamptz;
    return;
  end if;

  v_newly_due := v_plan.review_due_at is null and p_review_due_at is not null;

  delete from shift_adjust_plan_reviews rv where rv.plan_id = p_plan_id;
  get diagnostics v_cleared = row_count;

  update shift_adjust_plans pl
     set assignments = p_assignments,
         note = nullif(btrim(coalesce(p_note, '')), ''),
         review_due_at = p_review_due_at,
         updated_at = v_now,
         reviews_reset_at = case when v_cleared > 0 then v_now else pl.reviews_reset_at end,
         reviews_reset_count = case when v_cleared > 0 then v_cleared else pl.reviews_reset_count end,
         -- 期限を未来にしたら、期限の知らせ済みの印を戻す（もう一度期限を過ぎたら知らせる）
         expired_notified_at = case when p_review_due_at is not null and p_review_due_at > v_now then null else pl.expired_notified_at end
   where pl.id = p_plan_id;

  insert into shift_adjust_comments (slot_id, user_id, body)
  values (v_slot_id, auth.uid(),
          '案' || v_plan.plan_no::text || 'を直しました'
          || case when v_cleared > 0 then '（確認はやり直し）' else '' end
          || case when coalesce(p_summary, '') <> '' then '：' || p_summary else '' end);

  -- あとから意見の期限を付けたら、そこで初めて知らせる
  if v_newly_due then
    begin
      perform public.shift_adjust_notify_plan_created(p_plan_id);
    exception when others then
      raise warning '[shift_adjust_plan_update] 案の知らせを送れませんでした: %', sqlerrm;
    end;
  end if;

  return query select true, ''::text, v_now;
end $$;
revoke execute on function public.shift_adjust_plan_update(uuid, jsonb, text, timestamptz, text, timestamptz) from public;
revoke execute on function public.shift_adjust_plan_update(uuid, jsonb, text, timestamptz, text, timestamptz) from anon;
grant execute on function public.shift_adjust_plan_update(uuid, jsonb, text, timestamptz, text, timestamptz) to authenticated;

-- ------------------------------------------------------------
-- ③-3 案を消す（作った本人。消すことだけは管理者も可）
-- ------------------------------------------------------------
create or replace function public.shift_adjust_plan_delete(p_plan_id uuid, p_expected_updated_at timestamptz)
returns table(ok boolean, reason text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_admin boolean;
  v_plan     shift_adjust_plans%rowtype;
  v_slot     shift_adjust_slots%rowtype;
  v_slot_id  uuid;
  v_n        int;
begin
  v_is_admin := coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);

  select pl.slot_id into v_slot_id from shift_adjust_plans pl where pl.id = p_plan_id;
  if v_slot_id is null then
    return query select false, 'この案は見つかりません（すでに消されたか、決定で片付いた可能性があります）'::text;
    return;
  end if;
  select * into v_slot from shift_adjust_slots s where s.id = v_slot_id for update;
  select * into v_plan from shift_adjust_plans pl where pl.id = p_plan_id for update;
  if not found then
    return query select false, 'この案は見つかりません（すでに消されたか、決定で片付いた可能性があります）'::text;
    return;
  end if;
  if not v_is_admin then
    if v_plan.created_by is distinct from auth.uid()
       or not public.has_feature_permission('shift_adjust_plan') then
      return query select false, '案を消せるのは、作った本人（と管理者）だけです'::text;
      return;
    end if;
    if v_slot.target_user_id = auth.uid() then
      return query select false, '自分の休みの調整は、この画面からは変えられません'::text;
      return;
    end if;
  end if;
  if v_plan.updated_at is distinct from p_expected_updated_at then
    return query select false, 'conflict'::text;
    return;
  end if;

  delete from shift_adjust_plans pl where pl.id = p_plan_id;
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return query select false, 'この案は見つかりません'::text;
    return;
  end if;

  insert into shift_adjust_comments (slot_id, user_id, body)
  values (v_slot_id, auth.uid(), '案' || v_plan.plan_no::text || 'を消しました');

  return query select true, ''::text;
end $$;
revoke execute on function public.shift_adjust_plan_delete(uuid, timestamptz) from public;
revoke execute on function public.shift_adjust_plan_delete(uuid, timestamptz) from anon;
grant execute on function public.shift_adjust_plan_delete(uuid, timestamptz) to authenticated;

-- ------------------------------------------------------------
-- ③-4 「確認した」（確認の権限がある人。作った本人・休む本人は除く）
--      🚨 見ていた案の更新日時を渡す。直されたあとなら断る（古い中身への確認を新しい中身に付けない）
-- ------------------------------------------------------------
create or replace function public.shift_adjust_plan_review(p_plan_id uuid, p_expected_updated_at timestamptz)
returns table(ok boolean, reason text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_plan    shift_adjust_plans%rowtype;
  v_slot    shift_adjust_slots%rowtype;
  v_slot_id uuid;
begin
  if not (public.has_feature_permission('shift_adjust_review') and public.has_feature_permission('shift_adjust_view')) then
    return query select false, '案を確認する権限がありません（管理画面の「権限管理」で設定します）'::text;
    return;
  end if;

  select pl.slot_id into v_slot_id from shift_adjust_plans pl where pl.id = p_plan_id;
  if v_slot_id is null then
    return query select false, 'この案は見つかりません（消されたか、決定で片付いた可能性があります）'::text;
    return;
  end if;
  select * into v_slot from shift_adjust_slots s where s.id = v_slot_id for update;
  select * into v_plan from shift_adjust_plans pl where pl.id = p_plan_id for update;
  if not found then
    return query select false, 'この案は見つかりません（消されたか、決定で片付いた可能性があります）'::text;
    return;
  end if;
  if v_plan.created_by = auth.uid() then
    return query select false, '自分で作った案には「確認した」を付けられません'::text;
    return;
  end if;
  if v_slot.target_user_id = auth.uid() then
    return query select false, '自分の休みの調整は、この画面からは変えられません'::text;
    return;
  end if;
  if v_slot.status not in ('pending', 'working') then
    return query select false, 'この場はもう決まっているか、閉じています'::text;
    return;
  end if;
  if v_plan.updated_at is distinct from p_expected_updated_at then
    return query select false, 'conflict'::text;
    return;
  end if;

  insert into shift_adjust_plan_reviews (plan_id, user_id)
  values (p_plan_id, auth.uid())
  on conflict on constraint shift_adjust_plan_reviews_plan_user_key do nothing;

  return query select true, ''::text;
end $$;
revoke execute on function public.shift_adjust_plan_review(uuid, timestamptz) from public;
revoke execute on function public.shift_adjust_plan_review(uuid, timestamptz) from anon;
grant execute on function public.shift_adjust_plan_review(uuid, timestamptz) to authenticated;

-- ------------------------------------------------------------
-- ③-5 「確認した」を取り消す（押した本人だけ）
-- ------------------------------------------------------------
create or replace function public.shift_adjust_plan_unreview(p_plan_id uuid)
returns table(ok boolean, reason text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n int;
begin
  if not public.has_feature_permission('shift_adjust_view') then
    return query select false, 'シフト調整を見る権限がありません'::text;
    return;
  end if;
  delete from shift_adjust_plan_reviews rv where rv.plan_id = p_plan_id and rv.user_id = auth.uid();
  get diagnostics v_n = row_count;
  if v_n = 0 then
    return query select false, '取り消す「確認した」がありません（案が直されたか、消された可能性があります）'::text;
    return;
  end if;
  return query select true, ''::text;
end $$;
revoke execute on function public.shift_adjust_plan_unreview(uuid) from public;
revoke execute on function public.shift_adjust_plan_unreview(uuid) from anon;
grant execute on function public.shift_adjust_plan_unreview(uuid) to authenticated;

-- ------------------------------------------------------------
-- ④ 案を消すトリガー（決定・休みの取消・日の経過・現行シフトで対応）
--    🚨 いまの「案を保存」のトリガー（trg_zz_shift_adjust_clear_saved_plan）は触らない（現行シフトでは消さない作りのまま）
--    「確認した」は外部キーの on delete cascade で一緒に消える
-- ------------------------------------------------------------
create or replace function public.trg_shift_adjust_clear_plans()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- 🚨 失敗しても状態の変更（決定など）は止めない
  begin
    delete from shift_adjust_plans where slot_id = new.id;
  exception when others then
    raise warning '[trg_shift_adjust_clear_plans] 案を消せませんでした: %', sqlerrm;
  end;
  return null;
end $$;
revoke execute on function public.trg_shift_adjust_clear_plans() from public;
revoke execute on function public.trg_shift_adjust_clear_plans() from anon;

drop trigger if exists trg_zz_shift_adjust_clear_plans on public.shift_adjust_slots;
create trigger trg_zz_shift_adjust_clear_plans
  after update on public.shift_adjust_slots
  for each row
  when (old.status is distinct from new.status
        and new.status in ('decided', 'cause_cancelled', 'closed_past', 'no_change'))
  execute function public.trg_shift_adjust_clear_plans();

-- ------------------------------------------------------------
-- ⑤ 通知設定の行（管理画面「通知」で止められるように）
--    🚨 宛先の役職は、確認の権限で最後に絞るので広めにしておく（フロア責任者に確認の権限を付けたときも届くように）
-- ------------------------------------------------------------
insert into notification_settings (event_key, channel, enabled, recipient)
select v.event_key, v.channel, v.enabled, v.recipient
  from (values
    ('shift_adjust:plan_created', 'site',  true,  '{"roles": ["リーダー", "フロア責任者", "マネージャー", "社長", "管理者"], "groupFilter": "same", "orgWideRoles": ["社長", "管理者"]}'),
    ('shift_adjust:plan_created', 'push',  true,  null),
    ('shift_adjust:plan_created', 'email', false, null),
    ('shift_adjust:plan_due',     'site',  true,  null),
    ('shift_adjust:plan_due',     'push',  true,  null),
    ('shift_adjust:plan_due',     'email', false, null)
  ) as v(event_key, channel, enabled, recipient)
 where not exists (select 1 from notification_settings ns where ns.event_key = v.event_key and ns.channel = v.channel);
