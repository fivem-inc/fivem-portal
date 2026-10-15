-- セキュリティの穴ふさぎ（2026-10-15・ユーザー承認）
-- ① 安否確認の関数2つを、ログインなし（anon）・ログイン済み（authenticated）から閉じる
--    ・notify_safety_urgent … 呼ぶのは submit_safety_response(_proxy)（SECURITY DEFINER・所有者 postgres）の中だけ。
--      誰からも直接は呼ばれない。閉じても入れ子の呼び出しは所有者の権限で動くので止まらない
--    ・claim_safety_check_reminders … 呼ぶのは Edge Function safety-check-remind（service_role）だけ。
--      それまで anon だけ閉じ忘れていた（revoke from public, authenticated だけだった）
-- ② 社外向けFAQの検索の記録（faq_public_log → faq_query_log）に1日の上限（2万件）。
--    誰でも書ける入口なのに上限が無く、大量に書かれると「新しい順に20万行」の枠から本物の記録が押し出される。
--    faq_public_event_log と同じ仕組み。🚨 表は分ける（faq_event_quota を共用すると2つの関数で同じ上限を取り合う）
-- 🚨 faq_public_log は本番の実定義（pg_get_functiondef）から起こしている

begin;

-- ① 安否確認
revoke execute on function public.notify_safety_urgent(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.claim_safety_check_reminders(timestamptz, integer) from public, anon, authenticated;
grant  execute on function public.claim_safety_check_reminders(timestamptz, integer) to service_role;

-- ② FAQ の検索の記録の上限
create table if not exists public.faq_query_quota (
  day date primary key,
  n   integer not null default 0
);
alter table public.faq_query_quota enable row level security;
revoke all on table public.faq_query_quota from public, anon, authenticated;
comment on table public.faq_query_quota is '社外向けFAQの検索の記録（faq_query_log）の1日の件数。faq_public_log が数え、2万件を超えた分は記録しない。90日で消す';

create or replace function public.faq_public_log(p_raw_query text, p_had_match boolean, p_school text default null::text, p_course text default null::text, p_picked_topic_id uuid default null::uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_topic uuid;
  v_n     integer;
begin
  if p_raw_query is null or btrim(p_raw_query) = '' then
    return;
  end if;

  -- 1日の上限（2026-10-15）。超えた分はエラーを出さずに記録しないだけ（利用者の画面は変わらない）
  insert into public.faq_query_quota (day, n)
  values ((now() at time zone 'Asia/Tokyo')::date, 1)
  on conflict (day) do update set n = public.faq_query_quota.n + 1
  returning n into v_n;
  if v_n > 20000 then
    return;
  end if;

  -- 選ばれた質問は「社外向けかつ公開中」のものだけ受け付ける。
  -- 誰でも叩けるので、社内向けQ&AのIDを渡されても記録しない
  if p_picked_topic_id is not null then
    select id into v_topic
    from public.faq_topics
    where id = p_picked_topic_id
      and audience = 'public'
      and is_published = true;
  end if;

  insert into public.faq_query_log
    (audience, raw_query, school, course, role_title, had_match, picked_topic_id)
  values
    ('public',                 -- 社内向けとして記録させない（呼び出し側に選ばせない）
     left(p_raw_query, 500),
     left(p_school, 100),
     left(p_course, 100),
     null,                     -- 役職は社外の入口では持たない
     coalesce(p_had_match, false),
     v_topic);
end;
$function$;

-- 数えた行の掃除（90日）。既存の purge-faq-query-log（3:55 JST）の5分後
select cron.unschedule(jobid) from cron.job where jobname = 'purge-faq-query-quota';
select cron.schedule(
  'purge-faq-query-quota',
  '0 19 * * *',
  $cron$ delete from public.faq_query_quota where day < (now() at time zone 'Asia/Tokyo')::date - 90; $cron$
);

commit;
