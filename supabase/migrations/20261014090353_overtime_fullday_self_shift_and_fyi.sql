-- 残業申請の終日の休み（時間外調整休・振替休日・欠勤）を休暇とそろえる（2026-10-14 ユーザー確定・一問一答）
-- ① 自分で受理するとき、送る前に「シフト調整：必要／調整不要」を選べる（画面）。
--    🚨 調整不要を書けるのは管理者か「シフト調整の記録」（leave_shift_adjust）の権限がある人だけ。DB でも確かめる（画面だけに頼らない）。
--    だれが・いつ決めたか（shift_adjusted_by/at）はここで入れる
-- ② 受理されたら（上長の受理・自分で受理・経理が代わりに受理のどれでも）、休暇と同じ「受理されました」のお知らせを
--    休暇と同じ相手（通知設定 leave:approved_fyi）へ。ベル＋スマホ（スマホは同じ設定の push が ON のとき）
-- ③ 1か月前のシフト調整のお知らせ（remind-leave-shift-adjust）用に、相談の場へ送った印の列を足す
begin;

-- ① 調整不要の権限
create or replace function public.enforce_overtime_shift_not_needed()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare v_uid uuid := auth.uid();
begin
  if coalesce(new.shift_adjust_not_needed, false)
     and (tg_op = 'INSERT' or coalesce(old.shift_adjust_not_needed, false) is distinct from true) then
    -- 画面から（ログインした人の操作）のときだけ確かめる。Edge Function（service_role）は自分で確かめている
    if v_uid is not null then
      if not (coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') = 'admin'
              or public.user_has_feature_permission(v_uid, 'leave_shift_adjust')) then
        raise exception '「シフト調整：調整不要」を選べるのは、シフト調整の記録の権限がある方だけです';
      end if;
      new.shift_adjusted_by := coalesce(new.shift_adjusted_by, v_uid);
    end if;
    new.shift_adjusted_at := coalesce(new.shift_adjusted_at, now());
  end if;
  return new;
end $$;
revoke execute on function public.enforce_overtime_shift_not_needed() from public, anon;

drop trigger if exists trg_overtime_shift_not_needed on public.overtime_reports;
create trigger trg_overtime_shift_not_needed
  before insert or update of shift_adjust_not_needed on public.overtime_reports
  for each row execute function public.enforce_overtime_shift_not_needed();

-- ② 受理されましたのお知らせ（休暇の leave-approved-notify と同じ相手・同じ形）
create or replace function public.notify_overtime_fullday_fyi()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_site_on boolean; v_site_rcp text; v_push_on boolean; v_rcp jsonb;
  v_label text; v_name text; v_msg text; r record;
begin
  if new.entry_type is distinct from 'manual' or new.status is distinct from 'confirmed' then return new; end if;
  if tg_op = 'UPDATE' and old.status is not distinct from 'confirmed' then return new; end if;
  if not (coalesce(new.application_types, '{}') && array['chosei_off', 'furikae_off', 'absence']) then return new; end if;

  begin
    select ns.enabled, ns.recipient into v_site_on, v_site_rcp
      from notification_settings ns where ns.event_key = 'leave:approved_fyi' and ns.channel = 'site';
    -- 🚨 休暇と同じ：設定が無い・OFF なら送らない
    if v_site_on is not true then return new; end if;
    select ns.enabled into v_push_on
      from notification_settings ns where ns.event_key = 'leave:approved_fyi' and ns.channel = 'push';
    begin
      v_rcp := coalesce(nullif(v_site_rcp, '')::jsonb, '{}'::jsonb);
    exception when others then v_rcp := '{}'::jsonb;
    end;

    v_label := case
      when 'chosei_off' = any(new.application_types) then '時間外調整休'
      when 'furikae_off' = any(new.application_types) then '振替休日'
      else '欠勤' end;
    select coalesce(name, '') into v_name from profiles where id = new.applicant_id;
    v_msg := '🕐 ' || v_label || 'が受理されました「' || v_name || '（' || extract(month from new.work_date)::int || '/' || extract(day from new.work_date)::int || '（' || (array['日','月','火','水','木','金','土'])[extract(dow from new.work_date)::int + 1] || '））」';

    for r in
      select rid as user_id from public.resolve_role_recipients(new.applicant_id, v_rcp) rid
       where rid <> new.applicant_id
    loop
      insert into notifications (user_id, message, sub_message, source_type, event_key, reference_id)
      values (r.user_id, v_msg, null, 'overtime:fullday_fyi',
              case when coalesce(v_push_on, false) then 'overtime:fullday_fyi' end,
              new.work_date::text);
    end loop;
  exception when others then
    -- 🚨 お知らせが送れなくても受理そのものは止めない
    raise warning '[notify_overtime_fullday_fyi] お知らせを送れませんでした: %', sqlerrm;
  end;
  return new;
end $$;
revoke execute on function public.notify_overtime_fullday_fyi() from public, anon;

drop trigger if exists trg_overtime_fullday_fyi on public.overtime_reports;
create trigger trg_overtime_fullday_fyi
  after insert or update of status on public.overtime_reports
  for each row execute function public.notify_overtime_fullday_fyi();

-- ③ 1か月前のお知らせを送った印（相談の場ごと）
alter table public.shift_adjust_slots add column if not exists shift_alert_1m_sent_at timestamptz;


-- ④ 社内FAQ を今の動きに合わせる（上書き・今日から事実が変わるため）
update public.faq_topics
   set question = '「シフト調整がまだの休みが◯件」の通知が来た', updated_at = now()
 where id = (select topic_id from public.faq_answers where id = 'b0000000-0000-4000-8000-000000000915');
update public.faq_answers
   set body = replace(replace(body,
         '受理済みなのにシフト調整がまだの休暇をお知らせします。休暇の最初の日の3か月前と1か月前の、最大2回です（受理が1か月前を過ぎていれば1回）。',
         '受理済みなのにシフト調整がまだの休みをお知らせします。休暇は、最初の日の3か月前と1か月前の、最大2回です（受理が1か月前を過ぎていれば1回）。' || chr(10)
         || '残業申請の終日の休み（時間外調整休・振替休日・欠勤）は、1か月前の1回だけです（1か月前を過ぎてから受理された休みには届きません）。'),
         'その休暇の全部の日が決まると、次から届きません',
         'その休みの全部の日が決まると、次から届きません'),
       updated_at = now()
 where id = 'b0000000-0000-4000-8000-000000000915';
update public.faq_answers
   set body = replace(body,
         'マネージャーが休暇を受理するときに「シフト調整：必要／調整不要」を選ぶこともできます（その休暇の全部の日に効きます）。',
         'マネージャーが休暇を受理するときに「シフト調整：必要／調整不要」を選ぶこともできます（その休暇の全部の日に効きます）。' || chr(10)
         || '残業申請の終日の休み（時間外調整休・振替休日・欠勤）も、受理するときに選べます。自分で受理するときは、送る前に選べます（判断がつかない場合も「必要」を選択してください。マネージャーなどが判断します）。'),
       updated_at = now()
 where id = 'b0000000-0000-4000-8000-000000000914';

commit;
