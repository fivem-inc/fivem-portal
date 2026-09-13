-- シフト調整：手順8 管理画面の設定（毎朝のまとめ・自動登録の開始日・選ばれなかった方への連絡）
--
-- 設計は docs/計画-シフト調整.md の「10. お知らせ」「7. 決定したとき」。
-- 2026-09-13 ユーザー確定：
--   ・毎朝のまとめ … 対象（未調整＋調整中／未調整だけ）を切り替え／何日以内（既定7日）／
--                    送る時刻（既定9時）／送る曜日（既定 毎日）
--   ・宛先 … 「シフト調整を見る」権限がある人のうち、通知一覧で選んだ役職の人
--   ・ベルだけにする … 通知一覧のスマホ通知 ON/OFF を使う（同じ設定を2か所に置かない）
--   ・自動登録の開始日 … パート（勤怠の登録）と正社員（残業申請の依頼）で別々に持つ。
--        休みの日が開始日以降なら決定画面のチェックの初期値を ON、それより前か未設定なら OFF。
--        🚨 サーバーでは止めない（押せば登録・依頼はできる。例外対応を止めない）
--   ・選ばれなかったパートへの連絡 … 返事の画面に出すだけ（既定）／ベルでも知らせる
--
-- 【🚨 Edge Function は使わない】毎朝の片付け（20260913141902）と同じく DB の中だけで完結する。
--   Edge Function は失敗しても画面上は成功に見えるため、増やさない。
--
-- 【🚨 送った印の表は作らない】計画書どおり `notifications` の reference_id に
--   'shift_adjust_digest:YYYY-MM-DD' を入れ、前の日のぶんは消す。表を作らないので掃除も不要。

-- ───────────────────────────────────────────────────────────────
-- 1. 設定の表（1行だけ）
-- ───────────────────────────────────────────────────────────────
create table if not exists public.shift_adjust_settings (
  id                     int primary key default 1,
  -- 毎朝のまとめ
  digest_enabled         boolean not null default true,
  -- true＝未調整＋調整中／false＝未調整だけ
  digest_include_working boolean not null default true,
  -- 今日から何日先までを対象にするか（今日＋この日数の日まで）
  digest_days            int     not null default 7,
  -- 送る時刻（日本時間）。cron は15分おきに動き、この時刻を過ぎた最初の回で送る
  digest_time            time    not null default '09:00',
  -- 送る時間帯の幅（分）。🚨 幅が無いと、昼すぎに受理された休みが夕方に「毎朝のまとめ」として届く
  digest_window_minutes  int     not null default 120,
  -- 送る曜日（0＝日 … 6＝土）
  digest_weekdays        int[]   not null default '{0,1,2,3,4,5,6}',
  -- 自動登録の開始日。null＝未設定（初期値は OFF）
  attendance_from        date,   -- パート：勤怠の登録
  request_from           date,   -- 正社員：残業申請の依頼
  -- 選ばれなかったパートへの連絡：'screen'＝返事の画面に出すだけ／'bell'＝ベルでも知らせる
  notify_unpicked        text    not null default 'screen',
  updated_at             timestamptz not null default now(),
  constraint shift_adjust_settings_single   check (id = 1),
  constraint shift_adjust_settings_days     check (digest_days between 1 and 60),
  constraint shift_adjust_settings_window   check (digest_window_minutes between 15 and 720),
  -- 🚨 日をまたぐ時間帯は判定できないので作らせない
  constraint shift_adjust_settings_same_day check (
    extract(hour from digest_time)::int * 60 + extract(minute from digest_time)::int + digest_window_minutes <= 1440),
  constraint shift_adjust_settings_weekdays check (
    cardinality(digest_weekdays) >= 1 and digest_weekdays <@ '{0,1,2,3,4,5,6}'::int[]),
  constraint shift_adjust_settings_unpicked check (notify_unpicked in ('screen', 'bell'))
);

insert into public.shift_adjust_settings (id) values (1) on conflict (id) do nothing;

comment on table public.shift_adjust_settings is
  'シフト調整の設定（1行）。毎朝のまとめ・自動登録の開始日・選ばれなかった方への連絡。宛先は notification_settings の shift_adjust:digest で指定する';

alter table public.shift_adjust_settings enable row level security;

-- 読みはログインした人全員（決定画面がチェックの初期値を決めるのに使う）、書きは管理者だけ
drop policy if exists sas_select on public.shift_adjust_settings;
create policy sas_select on public.shift_adjust_settings for select to authenticated using (true);

drop policy if exists sas_update on public.shift_adjust_settings;
create policy sas_update on public.shift_adjust_settings for update to authenticated
  using (coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false))
  with check (coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false));

revoke all on public.shift_adjust_settings from anon;

-- ───────────────────────────────────────────────────────────────
-- 2. 「ある人が、その機能の権限を持つか」
-- ───────────────────────────────────────────────────────────────
-- 🚨 既存の has_feature_permission() は **ログイン中の人（auth.uid()）** しか見られない。
--    毎朝の cron にはログイン中の人がいないので、人を指定して見る版が要る。
-- 🚨 判定は has_feature_permission() と同じ形にしてある（role_id が空なら役職名で引く）。
--    **あちらを直すときはこちらも直すこと**。あちらを書き換えて共通化する案は、
--    全画面の RLS が通る関数に触ることになるので採らなかった。
-- 🚨 管理者は常に可（画面の決まりと同じ）。cron では JWT が無いので auth.users を見る。
create or replace function public.user_has_feature_permission(p_user uuid, p_feature text)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce(
    exists (select 1 from auth.users u
             where u.id = p_user and (u.raw_app_meta_data ->> 'role') = 'admin')
    or exists (
      select 1
        from profiles p
        join roles r
          on r.id = p.role_id
          or (p.role_id is null and r.name = p.role_title)
        join feature_permissions fp
          on fp.role_id = r.id and fp.feature_key = p_feature
       where p.id = p_user and fp.enabled
    ), false);
$function$;

revoke execute on function public.user_has_feature_permission(uuid, text) from public;
revoke execute on function public.user_has_feature_permission(uuid, text) from anon;
revoke execute on function public.user_has_feature_permission(uuid, text) from authenticated;

comment on function public.user_has_feature_permission(uuid, text) is
  '人を指定して機能権限を見る（cron 用）。🚨 判定は has_feature_permission() と同じ。片方だけ直さないこと。';

-- ───────────────────────────────────────────────────────────────
-- 3. 毎朝のまとめを送る
-- ───────────────────────────────────────────────────────────────
create or replace function public.shift_adjust_send_digest()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_st       shift_adjust_settings%rowtype;
  v_now      timestamp := now() at time zone 'Asia/Tokyo';
  v_today    date;
  v_min      int;
  v_start    int;
  v_ref      text;
  v_site_on  boolean;
  v_site_rcp text;
  v_rcp      jsonb := '{}'::jsonb;
  v_statuses text[];
  v_sent     int := 0;
  v_deleted  int := 0;
  r          record;
begin
  v_today := v_now::date;
  v_min   := extract(hour from v_now)::int * 60 + extract(minute from v_now)::int;
  v_ref   := 'shift_adjust_digest:' || to_char(v_today, 'YYYY-MM-DD');

  select * into v_st from shift_adjust_settings s where s.id = 1;
  if not found then
    return jsonb_build_object('ok', false, 'skipped', 'no settings');
  end if;
  if not v_st.digest_enabled then
    return jsonb_build_object('ok', true, 'skipped', 'disabled');
  end if;

  v_start := extract(hour from v_st.digest_time)::int * 60 + extract(minute from v_st.digest_time)::int;
  if v_min < v_start or v_min >= v_start + v_st.digest_window_minutes then
    return jsonb_build_object('ok', true, 'skipped', 'out of window');
  end if;

  -- 前の日のまとめを消す。🚨 残すとベルに昨日の件数が並び、今日の件数と食い違う
  delete from notifications n
   where n.source_type = 'shift_adjust:digest'
     and n.reference_id is distinct from v_ref;
  get diagnostics v_deleted = row_count;

  if not (extract(dow from v_today)::int = any(v_st.digest_weekdays)) then
    return jsonb_build_object('ok', true, 'skipped', 'weekday', 'deleted_old', v_deleted);
  end if;

  -- 宛先（管理画面の通知一覧「シフト調整の毎朝のまとめ」）
  select ns.enabled, ns.recipient into v_site_on, v_site_rcp
    from notification_settings ns
   where ns.event_key = 'shift_adjust:digest' and ns.channel = 'site';
  if v_site_on is false then
    return jsonb_build_object('ok', true, 'skipped', 'site off', 'deleted_old', v_deleted);
  end if;
  begin
    v_rcp := coalesce(nullif(v_site_rcp, '')::jsonb, '{}'::jsonb);
  exception when others then
    v_rcp := '{}'::jsonb;   -- 読めなければ resolve_role_recipients の既定で送る（権限で絞られる）
  end;

  v_statuses := case when v_st.digest_include_working then array['pending', 'working'] else array['pending'] end;

  for r in
    with s as (
      select sl.id, sl.target_user_id, sl.target_date, sl.status, coalesce(p.name, '') as name
        from shift_adjust_slots sl
        join profiles p on p.id = sl.target_user_id
       where sl.status = any(v_statuses)
         and sl.purged_at is null
         and sl.target_date between v_today and v_today + v_st.digest_days
         and p.is_active
    ),
    x as (
      -- 🚨 resolve_role_recipients は休んだ本人を必ず外す（p.id <> p_applicant）＝本人には届かない
      -- 🚨 さらに「シフト調整を見る」権限で絞る。押しても調整の場を開けない人には送らない
      select rid as user_id, s.target_date, s.status, s.name
        from s
        cross join lateral public.resolve_role_recipients(s.target_user_id, v_rcp) rid
       where public.user_has_feature_permission(rid, 'shift_adjust_view')
    )
    select x.user_id,
           count(*) as cnt,
           array_agg(
             to_char(x.target_date, 'FMMM/FMDD') || ' ' || x.name ||
             case when x.status = 'working' then '（調整中）' else '（未調整）' end
             order by x.target_date, x.name) as labels
      from x
     where not exists (
             select 1 from notifications n
              where n.user_id = x.user_id
                and n.source_type = 'shift_adjust:digest'
                and n.reference_id = v_ref)
     group by x.user_id
  loop
    insert into notifications (user_id, message, sub_message, source_type, event_key, reference_id)
    values (
      r.user_id,
      '🔁 シフト調整が済んでいない休みが' || r.cnt::text || '件あります（' || v_st.digest_days::text || '日以内）',
      array_to_string(r.labels[1:5], '／') ||
        case when r.cnt > 5 then ' 他' || (r.cnt - 5)::text || '件' else '' end,
      'shift_adjust:digest',
      'shift_adjust:digest',
      v_ref
    );
    v_sent := v_sent + 1;
  end loop;

  return jsonb_build_object('ok', true, 'today', v_today, 'sent', v_sent, 'deleted_old', v_deleted);
end $function$;

revoke execute on function public.shift_adjust_send_digest() from public;
revoke execute on function public.shift_adjust_send_digest() from anon;
revoke execute on function public.shift_adjust_send_digest() from authenticated;

comment on function public.shift_adjust_send_digest() is
  'シフト調整の毎朝のまとめ。cron shift-adjust-digest（15分おき）から呼ぶ。設定は shift_adjust_settings、宛先は notification_settings の shift_adjust:digest。';

-- 🚨 15分おき。「送る時刻を過ぎた最初の回」で送り、あとは reference_id の印で止まる
--    （`0 0 * * *` だと設定の時刻が効かず、落ちた回はその日送られない）
select cron.unschedule('shift-adjust-digest')
 where exists (select 1 from cron.job where jobname = 'shift-adjust-digest');

select cron.schedule('shift-adjust-digest', '*/15 * * * *', $cron$select public.shift_adjust_send_digest();$cron$);

-- ───────────────────────────────────────────────────────────────
-- 4. 通知設定の行（管理画面で宛先を選び、止められるようにする）
-- ───────────────────────────────────────────────────────────────
-- 🚨 行が無いと「通知は飛ぶのに管理画面から止められない」。必ず入れる。
-- 🚨 宛先の既定は、立場 leader / manager / president と管理者（accounting）の役職。
--    役職名は直書きせず roles の属性から作る（改名で壊れないように）。
--    保存の形は通知一覧の画面（parseRoleRecipient）と同じ「役職名の配列」。
--    実際に届くのはさらに「シフト調整を見る」権限がある人だけ（いまは社長・管理者）。
insert into notification_settings (event_key, channel, enabled, recipient, subject, template)
select 'shift_adjust:digest', 'site', true,
       jsonb_build_object(
         'roles',        coalesce((select jsonb_agg(r.name order by r.sort_order) from roles r
                                    where r.acts_as in ('leader', 'manager', 'president', 'accounting')), '[]'::jsonb),
         'groupFilter',  'same',
         'orgWideRoles', coalesce((select jsonb_agg(r.name order by r.sort_order) from roles r
                                    where r.is_org_wide), '[]'::jsonb)
       )::text,
       null,
       '🔁 シフト調整が済んでいない休みが{{件数}}件あります'
where not exists (select 1 from notification_settings where event_key = 'shift_adjust:digest' and channel = 'site');

insert into notification_settings (event_key, channel, enabled, recipient, subject, template)
select 'shift_adjust:digest', 'push', true, null, null, null
where not exists (select 1 from notification_settings where event_key = 'shift_adjust:digest' and channel = 'push');

insert into notification_settings (event_key, channel, enabled, recipient, subject, template)
select 'shift_adjust:digest', 'email', false, null, 'シフト調整が済んでいない休みがあります', null
where not exists (select 1 from notification_settings where event_key = 'shift_adjust:digest' and channel = 'email');

-- ───────────────────────────────────────────────────────────────
-- 5. 決定：選ばれなかった方への連絡／「決まった印」の付け直し
-- ───────────────────────────────────────────────────────────────
-- 🚨 本番の実定義（2026-09-13 に pg_get_functiondef で取得）から起こした。変えたのは2か所だけ：
--   (a) picked の更新を「割り当てに入っている人だけ true、それ以外は false」に。
--       🚨 決定を取り消す関数（shift_adjust_undecide）が picked を戻さないため、
--          取り消して別の方で決め直すと、前に選ばれた方にも「あなたに決定」と出ていた
--   (b) 設定が「ベルでも知らせる」のとき、選ばれなかった方にベルで知らせる。
--       🚨 決定の本体とは別の例外ブロック。知らせが失敗しても決定は巻き戻さない
--       🚨 同じ依頼に二度は送らない（取り消し→決め直しで重ならないように）
--       🚨 `event_key` は付けない＝ベルだけ（スマホは鳴らさない）
create or replace function public.shift_adjust_decide(p_slot_id uuid, p_assignments jsonb, p_do_attendance boolean DEFAULT true, p_do_request boolean DEFAULT true, p_memo text DEFAULT NULL::text)
 RETURNS TABLE(ok boolean, reason text, request_ids uuid[])
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_is_admin  boolean;
  v_slot      shift_adjust_slots%rowtype;
  v_a         jsonb;
  v_uid       uuid;
  v_kind      text;
  v_segs      jsonb;
  v_first     jsonb;
  v_loc       text;
  v_ae_id     uuid;
  v_req_id    uuid;
  v_reqs      uuid[] := '{}';
  v_name      text;
  v_can_ot    boolean;
begin
  v_is_admin := coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
  if not (v_is_admin or public.has_feature_permission('shift_adjust_decide')) then
    return query select false, 'シフト調整を決める権限がありません（管理画面の「役職・機能権限」で設定します）'::text, null::uuid[];
    return;
  end if;

  if p_assignments is null or jsonb_typeof(p_assignments) <> 'array' or jsonb_array_length(p_assignments) = 0 then
    return query select false, '入る人が1人も選ばれていません'::text, null::uuid[];
    return;
  end if;

  select * into v_slot from shift_adjust_slots s where s.id = p_slot_id for update;
  if not found then
    return query select false, 'この調整の場は見つかりません'::text, null::uuid[];
    return;
  end if;
  if v_slot.target_user_id = auth.uid() then
    return query select false, '自分の休みの調整は、この画面からは決められません'::text, null::uuid[];
    return;
  end if;
  if v_slot.status in ('closed_past', 'cause_cancelled') then
    return query select false, 'この場はもう閉じています（過ぎた日、または休みが取り消されました）'::text, null::uuid[];
    return;
  end if;
  if exists (select 1 from shift_adjust_assignments a where a.slot_id = p_slot_id) then
    return query select false, 'すでに決まっています。変えるときは先に「決定を取り消す」を押してください'::text, null::uuid[];
    return;
  end if;

  -- ═══ ここから書き込み。🚨 どれか1つでも失敗したら、全部やめる ═══
  begin
    for v_a in select * from jsonb_array_elements(p_assignments) loop
      v_uid  := (v_a ->> 'user_id')::uuid;
      v_kind := v_a ->> 'kind';
      v_segs := coalesce(v_a -> 'segments', '[]'::jsonb);

      if v_uid is null then
        raise exception '入る人が選ばれていません' using errcode = 'P0001';
      end if;
      if v_kind not in ('attendance', 'overtime_request') then
        raise exception '登録のしかたの指定が正しくありません' using errcode = 'P0001';
      end if;
      if jsonb_array_length(v_segs) = 0 then
        raise exception '時間帯が入っていません' using errcode = 'P0001';
      end if;
      if v_uid = v_slot.target_user_id then
        raise exception '休んでいる本人を代わりに入れることはできません' using errcode = 'P0001';
      end if;

      select pr.name into v_name from profiles pr where pr.id = v_uid;
      v_first := v_segs -> 0;
      v_loc   := nullif(v_first ->> 'location', '');

      v_ae_id  := null;
      v_req_id := null;

      if v_kind = 'attendance' and p_do_attendance then
        insert into attendance_exceptions (user_id, date, type, actual_time, location, work_segments, notes, created_by)
        values (v_uid, v_slot.target_date, 'holiday_work',
                (v_first ->> 'start')::time, v_loc, v_segs,
                nullif(p_memo, ''), auth.uid())
        returning id into v_ae_id;

      elsif v_kind = 'overtime_request' and p_do_request then
        select exists (
          select 1 from profiles pr
            join feature_permissions fp on fp.role_id = pr.role_id
           where pr.id = v_uid and fp.feature_key = 'overtime' and fp.enabled
        ) into v_can_ot;
        if not v_can_ot then
          raise exception '%さんは残業申請を使えません。勤怠での登録に切り替えるか、別の方を選んでください',
            coalesce(v_name, 'この方') using errcode = 'P0001';
        end if;
        insert into application_requests (requester_id, recipient_id, kind, target_dates, memo)
        values (auth.uid(), v_uid, 'overtime', array[v_slot.target_date], nullif(p_memo, ''))
        returning id into v_req_id;
        v_reqs := v_reqs || v_req_id;
      end if;

      insert into shift_adjust_assignments
        (slot_id, user_id, segments, kind, attendance_exception_id, application_request_id)
      values (p_slot_id, v_uid, v_segs, v_kind, v_ae_id, v_req_id);
    end loop;

    -- 出勤のお願いを送ってあった人の「決まった印」。パートの返事の画面が使う
    -- 🚨 2026-09-13（手順8）：「入った人だけ true」から「入った人は true・それ以外は false」に。
    --    取り消して別の方で決め直したとき、前の方の印が残らないように
    update shift_adjust_part_requests r
       set picked = (r.user_id in (select a.user_id from shift_adjust_assignments a where a.slot_id = p_slot_id))
     where r.slot_id = p_slot_id;

    update shift_adjust_slots s
       set status = 'decided', decided_by = auth.uid(), decided_at = now(), updated_at = now()
     where s.id = p_slot_id;

  exception
    when sqlstate '23514' then
      return query select false, sqlerrm::text, null::uuid[];
      return;
    when sqlstate '23505' then
      return query select false, '同じ人を2回選んでいます'::text, null::uuid[];
      return;
    when others then
      return query select false, sqlerrm::text, null::uuid[];
      return;
  end;

  -- 🚨 2026-09-13（手順8）：選ばれなかった方への連絡（設定が「ベルでも知らせる」のときだけ）
  begin
    if coalesce((select st.notify_unpicked from shift_adjust_settings st where st.id = 1), 'screen') = 'bell' then
      insert into notifications (user_id, message, sub_message, source_type, reference_id)
      select r.user_id,
             '📅 ' || to_char(v_slot.target_date, 'FMMM/FMDD') || 'の出勤のお願いについて',
             'この日の担当は決定しました。ご返事ありがとうございました。',
             'shift_adjust:part_request_closed',
             r.id::text
        from shift_adjust_part_requests r
       where r.slot_id = p_slot_id
         and not r.picked
         and not exists (
               select 1 from notifications n
                where n.user_id = r.user_id
                  and n.source_type = 'shift_adjust:part_request_closed'
                  and n.reference_id = r.id::text);
    end if;
  exception when others then
    raise warning '[shift_adjust_decide] 選ばれなかった方への連絡を送れませんでした: %', sqlerrm;
  end;

  return query select true, ''::text, v_reqs;
end $function$;
