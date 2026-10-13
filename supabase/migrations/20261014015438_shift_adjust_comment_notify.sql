-- シフト調整の相談：コメントを知らせる／期限なしの案も知らせる（2026-10-14 ユーザー確定・一問一答）
-- ・コメント：毎朝のまとめ（shift_adjust:digest）と同じ相手＝同じチームのリーダー・マネージャー＋社長・管理者（通知設定で変えられる）。
--   見る権限（shift_adjust_view）のある人だけ。休んだ本人・書いた本人には届けない。ベル＋スマホ（event_key shift_adjust:comment）
--   文：「🔁 10/20（火）のシフト調整にコメントがありました」／「Aさんの休み・Bさん「（先頭30字）…」」（ユーザー確定 案1）
--   🚨 呼ぶのは画面の［送信］だけ（shift_adjust_comment_notify）。案を作った・決定した の自動の記録はコメントとして知らせない
-- ・案：期限を付けない案も、期限付きと同じ相手に知らせる（shift_adjust_notify_plan_created / shift_adjust_plan_create は本番の実定義から起こした）
begin;

alter table public.shift_adjust_comments add column if not exists notified_at timestamptz;

-- 通知設定（🚨 新しい種類は「設定が無い＝全員」になる所があるので必ず行を作る）。相手は今の毎朝のまとめと同じ値を写す
insert into public.notification_settings (event_key, channel, enabled, recipient)
select 'shift_adjust:comment', 'site', true,
       coalesce((select recipient from public.notification_settings where event_key = 'shift_adjust:digest' and channel = 'site'),
                '{"roles":["リーダー","マネージャー","社長","管理者"],"groupFilter":"same","orgWideRoles":["社長","管理者"]}')
on conflict (event_key, channel) do nothing;
insert into public.notification_settings (event_key, channel, enabled) values ('shift_adjust:comment', 'push', true)
on conflict (event_key, channel) do nothing;

CREATE OR REPLACE FUNCTION public.shift_adjust_notify_plan_created(p_plan_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  if not found then return 0; end if;   -- 2026-10-14：期限なしの案も知らせる
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
      v_name || 'さんの休み・案' || v_plan.plan_no::text
        || case when v_plan.review_due_at is not null
                then '・意見の期限 ' || to_char(v_plan.review_due_at at time zone 'Asia/Tokyo', 'FMMM/FMDD HH24:MI')
                else '' end,
      'shift_adjust:plan_created',
      'shift_adjust:plan_created',
      v_slot.id
    );
    v_sent := v_sent + 1;
  end loop;
  return v_sent;
end $function$;

CREATE OR REPLACE FUNCTION public.shift_adjust_plan_create(p_slot_id uuid, p_assignments jsonb, p_note text, p_review_due_at timestamp with time zone, p_summary text)
 RETURNS TABLE(ok boolean, reason text, out_plan_id uuid, out_plan_no integer, out_updated_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- 案を作ったら知らせる（2026-10-14：期限なしの案も。それまでは期限を付けた案だけで、期限なしはだれにも知らされなかった）。
  -- 🚨 失敗しても案は作れたことにする
  begin
    perform public.shift_adjust_notify_plan_created(v_id);
  exception when others then
    raise warning '[shift_adjust_plan_create] 案の知らせを送れませんでした: %', sqlerrm;
  end;

  return query select true, ''::text, v_id, v_no, v_now;
end $function$;

-- コメントを知らせる（画面の［送信］のあとに1回だけ呼ぶ。書いた本人だけ・書いてから10分以内・まだ知らせていないものだけ）
create or replace function public.shift_adjust_comment_notify(p_comment_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_c     shift_adjust_comments%rowtype;
  v_slot  shift_adjust_slots%rowtype;
  v_on    boolean;
  v_rcp_t text;
  v_rcp   jsonb;
  v_name  text;
  v_from  text;
  v_body  text;
  v_sent  int := 0;
  r       record;
begin
  -- 🚨 二重に知らせない：印を先に付け、付けられたときだけ進む
  update shift_adjust_comments set notified_at = now()
   where id = p_comment_id and user_id = auth.uid() and notified_at is null
     and created_at > now() - interval '10 minutes'
  returning * into v_c;
  if not found then return 0; end if;
  select * into v_slot from shift_adjust_slots where id = v_c.slot_id;
  if not found then return 0; end if;

  select ns.enabled, ns.recipient into v_on, v_rcp_t
    from notification_settings ns
   where ns.event_key = 'shift_adjust:comment' and ns.channel = 'site';
  -- 🚨 設定が無い・OFF なら送らない（送らない側に倒す）
  if v_on is not true then return 0; end if;
  begin
    v_rcp := coalesce(nullif(v_rcp_t, '')::jsonb, '{}'::jsonb);
  exception when others then
    v_rcp := '{}'::jsonb;
  end;

  select coalesce(name, '') into v_name from profiles where id = v_slot.target_user_id;
  select coalesce(name, '') into v_from from profiles where id = v_c.user_id;
  v_body := regexp_replace(btrim(v_c.body), '\s+', ' ', 'g');
  if char_length(v_body) > 30 then v_body := left(v_body, 30) || '…'; end if;

  for r in
    select rid as user_id
      from public.resolve_role_recipients(v_slot.target_user_id, v_rcp) rid
     where rid <> v_c.user_id
       and rid <> v_slot.target_user_id
       and public.user_has_feature_permission(rid, 'shift_adjust_view')
  loop
    insert into notifications (user_id, message, sub_message, source_type, event_key, reference_id)
    values (
      r.user_id,
      '🔁 ' || public.shift_adjust_date_label(v_slot.target_date) || 'のシフト調整にコメントがありました',
      v_name || 'さんの休み・' || v_from || 'さん「' || v_body || '」',
      'shift_adjust:comment',
      'shift_adjust:comment',
      v_slot.id
    );
    v_sent := v_sent + 1;
  end loop;
  return v_sent;
end $$;
revoke execute on function public.shift_adjust_comment_notify(uuid) from public;
revoke execute on function public.shift_adjust_comment_notify(uuid) from anon;
grant execute on function public.shift_adjust_comment_notify(uuid) to authenticated;


-- 社内FAQ「『シフト調整』タブで何ができる？」の2か所を今の動きに直す（画面の動きが今日から変わるので上書き）
update public.faq_answers
   set body = replace(replace(body,
         '③相談：日ごとに書き込めます（書き込んでも通知は届きません）',
         '③相談：日ごとに書き込めます（書き込むと、同じチームの上長などにお知らせが届きます。休む本人には届きません）'),
         '「意見の期限」を付けると、確認する方にお知らせが届きます。',
         '案を作ると、確認する方にお知らせが届きます（「意見の期限」も付けられます）。'),
       updated_at = now()
 where id = 'b0000000-0000-4000-8000-000000000932';

commit;
