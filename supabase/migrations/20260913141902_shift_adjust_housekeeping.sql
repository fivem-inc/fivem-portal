-- シフト調整：毎朝の片付け（手順6・7の残り）
--
-- 【この cron でやること】毎朝9時（日本時間）に2つ
--   ① 過ぎた日の未調整・調整中の場を **closed_past** にして、一覧から下ろす
--   ② 返事の期限が過ぎた「出勤のお願い」を、**送った人**に知らせる
--
-- 【🚨 Edge Function は使わない】
--   ①も②もDBの中だけで完結する（②の知らせは `notifications` に行を入れるだけ）。
--   Edge Function を増やすと deploy と型チェックの手間が増え、
--   しかも**失敗しても画面上は成功に見える**（(14) で1日気づけなかった形）。
--
-- 【🚨 ①で古い列（leave_requests.shift_adjust_status）は動かない】
--   手順4の逆向きの書き写しは `closed_past` を**数に入れない**ので、
--   場が閉じても休暇の列は 'pending' のまま＝**カレンダーの印は「未調整」のまま**。
--   これで正しい。「未調整のまま過ぎた休暇」が勝手に調整済みになってはいけない。
--
-- 【🚨 「退職した人の場を閉じる」は入れていない】
--   計画書には「対象者が在籍していなければ閉じる」とあるが、それには
--   `status` に新しい値（例 'target_left'）を足す必要があり、検査の作り直しになる。
--   `cause_cancelled` で代用すると画面が「休みが取り消されました」と**嘘をつく**。
--   退職者の未来の休みは普通は取り消されるので、急がないと判断した。**次にやる人へ申し送り**。

-- ───────────────────────────────────────────────────────────────
-- 1. 「誰が送ったか」と「期限切れを知らせたか」を持てるようにする
-- ───────────────────────────────────────────────────────────────
-- 🚨 手順2の表には送り主の列が無かった。「返事がありません」を誰に知らせるか決められない。
alter table public.shift_adjust_part_requests
  add column if not exists sent_by uuid references public.profiles(id) on delete set null;
-- 🚨 知らせた印が無いと、毎朝おなじ「返事がありません」が届き続ける（読まれなくなる）。
alter table public.shift_adjust_part_requests
  add column if not exists overdue_notified_at timestamptz;

comment on column public.shift_adjust_part_requests.sent_by is
  '出勤のお願いを送った人。返事の期限が過ぎたときの知らせ先。';
comment on column public.shift_adjust_part_requests.overdue_notified_at is
  '期限切れを知らせた日時。🚨 これが無いと毎朝おなじ知らせが届き続ける。';

-- ───────────────────────────────────────────────────────────────
-- 2. 送る関数に「誰が送ったか」を残す（1行足しただけ）
-- ───────────────────────────────────────────────────────────────
create or replace function public.shift_adjust_send_part_requests(
  p_slot_id  uuid,
  p_user_ids uuid[],
  p_segments jsonb,
  p_location text        default null,
  p_due_at   timestamptz default null
) returns table(ok boolean, reason text, request_ids uuid[], sent_names text[])
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_is_admin boolean;
  v_slot     shift_adjust_slots%rowtype;
  v_uid      uuid;
  v_id       uuid;
  v_ids      uuid[] := '{}';
  v_names    text[] := '{}';
  v_name     text;
  v_emp      text;
begin
  v_is_admin := coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
  if not (v_is_admin or public.has_feature_permission('shift_adjust_request')) then
    return query select false, 'パートへ出勤のお願いを送る権限がありません（管理画面の「役職・機能権限」で設定します）'::text,
                        null::uuid[], null::text[];
    return;
  end if;

  if p_user_ids is null or array_length(p_user_ids, 1) is null then
    return query select false, '送る相手が選ばれていません'::text, null::uuid[], null::text[];
    return;
  end if;
  if p_segments is null or jsonb_typeof(p_segments) <> 'array' or jsonb_array_length(p_segments) = 0 then
    return query select false, '時間帯が入っていません'::text, null::uuid[], null::text[];
    return;
  end if;

  select * into v_slot from shift_adjust_slots s where s.id = p_slot_id for update;
  if not found then
    return query select false, 'この調整の場は見つかりません'::text, null::uuid[], null::text[];
    return;
  end if;
  if v_slot.target_user_id = auth.uid() then
    return query select false, '自分の休みの調整は、この画面からは送れません'::text, null::uuid[], null::text[];
    return;
  end if;
  if v_slot.status in ('closed_past', 'cause_cancelled', 'no_change') then
    return query select false, 'この場はもう閉じています'::text, null::uuid[], null::text[];
    return;
  end if;

  begin
    foreach v_uid in array p_user_ids loop
      if v_uid = v_slot.target_user_id then
        raise exception '休んでいる本人に出勤のお願いは送れません' using errcode = 'P0001';
      end if;

      select pr.name, pr.employment_type into v_name, v_emp from profiles pr where pr.id = v_uid;
      if v_name is null then
        raise exception '送る相手が見つかりません' using errcode = 'P0001';
      end if;
      if v_emp is distinct from 'パート' then
        raise exception '%さんはパートではありません。正社員には決定のときに残業申請を依頼します', v_name
          using errcode = 'P0001';
      end if;

      insert into shift_adjust_part_requests
        (slot_id, user_id, target_date, segments, location, due_at, sent_by)
      values (p_slot_id, v_uid, v_slot.target_date, p_segments, nullif(p_location, ''), p_due_at, auth.uid())
      on conflict (slot_id, user_id) do nothing
      returning id into v_id;

      if v_id is not null then
        v_ids   := v_ids || v_id;
        v_names := v_names || v_name;
        v_id    := null;
      end if;
    end loop;

    if v_slot.status = 'pending' then
      update shift_adjust_slots s
         set status = 'working', updated_at = now()
       where s.id = p_slot_id;
    end if;
  exception when others then
    return query select false, sqlerrm::text, null::uuid[], null::text[];
    return;
  end;

  if array_length(v_ids, 1) is null then
    return query select false, '選んだ方には、すでに送ってあります'::text, null::uuid[], null::text[];
    return;
  end if;

  return query select true, ''::text, v_ids, v_names;
end $function$;

-- ───────────────────────────────────────────────────────────────
-- 3. 毎朝の片付け
-- ───────────────────────────────────────────────────────────────
-- 🚨 `0 0 * * *` ＝ UTC 0時 ＝ **日本時間の朝9時**。ほかの日次リマインドと同じ時刻に揃える。
select cron.unschedule('shift-adjust-housekeeping-daily')
 where exists (select 1 from cron.job where jobname = 'shift-adjust-housekeeping-daily');

select cron.schedule('shift-adjust-housekeeping-daily', '0 0 * * *', $cron$
do $$
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  r record;
begin
  -- ① 過ぎた日の未調整・調整中の場を閉じる
  -- 🚨 決定済み（decided）・確認済み（no_change）は触らない。片付いた記録をそのまま残す
  -- 🚨 割り当てがある場も触らない（決まっているのに閉じると記録が食い違う）
  update public.shift_adjust_slots s
     set status = 'closed_past', updated_at = now()
   where s.status in ('pending', 'working')
     and s.target_date < v_today
     and not exists (select 1 from public.shift_adjust_assignments a where a.slot_id = s.id);

  -- ② 返事の期限が過ぎた「出勤のお願い」を、送った人に知らせる
  -- 🚨 同じ人・同じ日のぶんはまとめて1通にする（1人に何通も届かないように）
  -- 🚨 `event_key` は付けない＝ベルだけ。スマホを鳴らすには push-dispatch の
  --    EVENT_MAP（2人共通）に足す必要があるので、そこは分けてある
  -- 🚨 文面に**パートの名前は書かない**（休んだ人の名前を出さない決まりと同じ考え方）
  for r in
    select q.sent_by, q.target_date, count(*) as cnt, (array_agg(q.id))[1] as any_id
      from public.shift_adjust_part_requests q
      join public.shift_adjust_slots s on s.id = q.slot_id
     where q.sent_by is not null
       and q.due_at is not null
       and q.due_at < now()
       and q.answer is null
       and q.overdue_notified_at is null
       and s.status in ('pending', 'working')
     group by q.sent_by, q.target_date
  loop
    insert into public.notifications (user_id, message, sub_message, source_type, reference_id)
    values (
      r.sent_by,
      '📅 ' || to_char(r.target_date, 'FMMM/FMDD') || 'の出勤のお願いに返事がありません（' || r.cnt::text || '件）',
      '返事の期限を過ぎました。別の方に声をかけるか、直接ご連絡ください。',
      'shift_adjust:part_request_overdue',
      r.any_id
    );

    update public.shift_adjust_part_requests q
       set overdue_notified_at = now()
     where q.sent_by = r.sent_by
       and q.target_date = r.target_date
       and q.answer is null
       and q.overdue_notified_at is null;
  end loop;
end;
$$;
$cron$);
