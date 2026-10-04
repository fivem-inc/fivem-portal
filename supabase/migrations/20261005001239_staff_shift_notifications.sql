-- ============================================================
-- 2026-10-05  ベルの通知を4つ足す（勤務表の保存・入社日・招待メールの失敗・初めてのログイン）
-- ============================================================
-- ✅ ユーザー確定（2026-10-04〜05）。宛先は「🔔 通知設定」で変えられる（notification_settings の channel='site'）
--   ① shift_roster:saved   勤務表（シフト）が保存された        → 管理者・社長（いつも）＋同じチームのマネージャー・リーダー
--   ③ staff:hired          入社予定の人が入社日に使えるようになった → 管理者・社長・マネージャー
--   ④ staff:invite_failed  招待メールを送れなかった（予約の送信） → 管理者・社長
--   ⑤ staff:first_login    入社した人が初めてログインした        → 管理者・社長
--   （「管理者」の役職は管理用のアカウントだけなので、晃平さん（社長）にも届くよう社長を入れた）
--   （② シフトが変わった本人への通知は作らない・ユーザー確定）
-- ・ベルだけ（banner_dismissed=true＝ホームのお知らせには出さない）。スマホ通知は出ない
--   （push-dispatch の EVENT_MAP に無い event_key は送らない作り。2026-10-05 に確認）
-- ・🚨 宛先の設定行を必ず入れる。設定が無い／オフなら送らない（notify_event が fail-closed）
-- ・同じチーム＝グループの「こども・大人・管理部」（master_options shift_report_group）。判定は既存の resolve_role_recipients

-- ── 宛先の設定（最初の値） ──────────────────────────────────
insert into public.notification_settings (event_key, channel, enabled, recipient) values
  ('shift_roster:saved',  'site',  true,  '{"roles":["リーダー","マネージャー","社長","管理者"],"groupFilter":"same"}'),
  ('shift_roster:saved',  'push',  false, null),
  ('shift_roster:saved',  'email', false, null),
  ('shift_roster:saved',  'slack', false, null),
  ('staff:hired',         'site',  true,  '{"roles":["マネージャー","社長","管理者"],"groupFilter":"all"}'),
  ('staff:hired',         'push',  false, null),
  ('staff:hired',         'email', false, null),
  ('staff:hired',         'slack', false, null),
  ('staff:invite_failed', 'site',  true,  '{"roles":["社長","管理者"],"groupFilter":"all"}'),
  ('staff:invite_failed', 'push',  false, null),
  ('staff:invite_failed', 'email', false, null),
  ('staff:invite_failed', 'slack', false, null),
  ('staff:first_login',   'site',  true,  '{"roles":["社長","管理者"],"groupFilter":"all"}'),
  ('staff:first_login',   'push',  false, null),
  ('staff:first_login',   'email', false, null),
  ('staff:first_login',   'slack', false, null)
on conflict (event_key, channel) do nothing;

-- ── 共通：設定の宛先へベルを出す ─────────────────────────────
-- p_subjects … 「誰について」の人（チームの絞り込みに使う。複数なら全員のチームを合わせる）
-- p_exclude  … 出さない人（操作した本人など）
create or replace function public.notify_event(
  p_event text, p_subjects uuid[], p_message text, p_sub text, p_source text, p_exclude uuid, p_created_by uuid
) returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_set record;
  v_count integer := 0;
begin
  select enabled, recipient into v_set from notification_settings where event_key = p_event and channel = 'site';
  if not found or not v_set.enabled or v_set.recipient is null then
    return 0;   -- 🚨 設定が無い・オフなら送らない（全員に飛ばさない）
  end if;

  insert into notifications (user_id, message, sub_message, source_type, event_key, created_by, banner_dismissed)
  select distinct r.uid, p_message, p_sub, p_source, p_event, p_created_by, true
    from unnest(coalesce(p_subjects, '{}'::uuid[])) s(subject),
         lateral resolve_role_recipients(s.subject, v_set.recipient::jsonb) r(uid)
   where p_exclude is null or r.uid <> p_exclude;
  get diagnostics v_count = row_count;
  return v_count;
exception when others then
  -- 🚨 通知の失敗で、呼んだ側の本来の処理（保存・入社の切り替え）を巻き込まない
  raise warning '[notify_event] % の通知に失敗しました: %', p_event, sqlerrm;
  return 0;
end;
$function$;
revoke execute on function public.notify_event(text, uuid[], text, text, text, uuid, uuid) from public;
revoke execute on function public.notify_event(text, uuid[], text, text, text, uuid, uuid) from anon;
revoke execute on function public.notify_event(text, uuid[], text, text, text, uuid, uuid) from authenticated;
grant execute on function public.notify_event(text, uuid[], text, text, text, uuid, uuid) to service_role;
comment on function public.notify_event(text, uuid[], text, text, text, uuid, uuid) is
  '通知設定（channel=site）の宛先へベルを出す共通の関数。設定が無い・オフなら0件（2026-10-05）';

-- ── ① 勤務表が保存された（画面がシフトの保存に成功した直後に呼ぶ） ──────────
create or replace function public.notify_shift_roster_saved(p_user_ids uuid[], p_from date)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_saver text;
  v_names text[];
  v_label text;
begin
  -- 🚨 シフトを保存できる人だけ（管理者・シフト管理を開いてあるマネージャー以上）
  if not public.can_manage_admin_tab('shift_patterns') then
    raise exception 'シフトを保存する権限がありません' using errcode = '42501';
  end if;
  if coalesce(cardinality(p_user_ids), 0) = 0 then return 0; end if;

  select regexp_replace(coalesce(name, ''), '[[:space:]　]+', ' ', 'g') into v_saver from profiles where id = auth.uid();
  select array_agg(split_part(regexp_replace(coalesce(name, ''), '[[:space:]　]+', ' ', 'g'), ' ', 1) order by name)
    into v_names from profiles where id = any(p_user_ids);
  v_label := array_to_string(v_names[1:3], '・')
             || case when cardinality(v_names) > 3 then format('ほか%s名', cardinality(v_names) - 3) else '' end;

  return public.notify_event(
    'shift_roster:saved', p_user_ids,
    format('📑 %sさんが勤務表を保存しました', coalesce(nullif(v_saver, ''), '管理者')),
    format('%s／%s〜', v_label, to_char(p_from, 'FMMM/FMDD')),
    'shift_roster:saved', auth.uid(), auth.uid());
end;
$function$;
revoke execute on function public.notify_shift_roster_saved(uuid[], date) from public;
revoke execute on function public.notify_shift_roster_saved(uuid[], date) from anon;
grant execute on function public.notify_shift_roster_saved(uuid[], date) to authenticated;

-- ── ③ 入社日に在籍へ切り替える（20261004155931 の版から起こし、通知を足した） ──────
create or replace function public.hire_daily()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  r record;
  v_count integer := 0;
begin
  for r in
    select id, name from profiles
     where is_active = false
       and hire_date is not null
       and hire_date <= (now() at time zone 'Asia/Tokyo')::date
       and retired_at is null
       and retire_date is null
       and coalesce(approval_status, '') <> 'pending'
  loop
    -- 🚨 1人ずつ失敗を受け止める（retire_daily と同じ）。失敗した人は入社予定のまま残り、管理画面に「切り替えに失敗」と出る
    begin
      update profiles set is_active = true, approval_status = 'approved' where id = r.id;
      v_count := v_count + 1;
      perform public.notify_event('staff:hired', array[r.id],
        format('👤 今日から%sさんがサイトを使えるようになりました', regexp_replace(coalesce(r.name, ''), '[[:space:]　]+', ' ', 'g')),
        '入社日になりました', 'staff:hired', r.id, null);
    exception when others then
      raise warning '[hire_daily] % の在籍への切り替えに失敗しました: %', r.id, sqlerrm;
    end;
  end loop;
  return v_count;
end;
$function$;
revoke execute on function public.hire_daily() from public;
revoke execute on function public.hire_daily() from anon;
revoke execute on function public.hire_daily() from authenticated;

-- ── ⑤ 入社した人が初めてログインした（入社予定から登録した人だけ＝hire_date がある人） ──────
create or replace function public.notify_first_login()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_name text;
begin
  if old.last_sign_in_at is null and new.last_sign_in_at is not null then
    select name into v_name from profiles where id = new.id and hire_date is not null;
    if found then
      perform public.notify_event('staff:first_login', array[new.id],
        format('👤 %sさんが初めてログインしました', regexp_replace(coalesce(v_name, ''), '[[:space:]　]+', ' ', 'g')),
        null, 'staff:first_login', new.id, null);
    end if;
  end if;
  return new;
exception when others then
  return new;   -- 🚨 通知の失敗でログインを止めない
end;
$function$;
revoke execute on function public.notify_first_login() from public;
revoke execute on function public.notify_first_login() from anon;
revoke execute on function public.notify_first_login() from authenticated;

drop trigger if exists on_auth_user_first_login on auth.users;
create trigger on_auth_user_first_login
  after update of last_sign_in_at on auth.users
  for each row execute function public.notify_first_login();

-- ④ 招待メールを送れなかった … Edge Function staff-onboard の send_due が notify_event を呼ぶ
