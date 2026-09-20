-- お客様向けFAQの利用状況を詳しくする（2026-09-20 ユーザー依頼）
--
-- 【何ができるようになるか】
--   スマホかPCか／社内からか社外からか／どの国・都道府県から／どこのページから来たか／
--   どれくらい見ていたか（滞在時間）／時間帯・曜日 が分かるようになる。
--
-- 【決まったこと（2026-09-20 ユーザー確定）】
--   ・IPアドレスは**保存する**（案B）。**2年で消す**（既存の掃除 cron が24か月なのでそのまま効く）
--   ・滞在時間は「同じ人の最初と最後の操作の差」＋「画面を閉じるときに送る実測」の両方
--   ・社内FAQ（スタッフ用）は**検索ワードだけ**。IP・端末・滞在時間は取らない（記録を増やさない）
--
-- 🚨 追加の通信は増やしていない。IP・端末・流入元・国は、いま呼んでいる関数の中で
--    「要求のヘッダー」から読み取る（2026-09-20 に本番で取れることを実測）。
--    都道府県だけはIPから引く必要があるので、列だけ用意して後の段で埋める。

-- ───────────────────────────────────────────────
-- 1. 記録する列を足す
-- ───────────────────────────────────────────────
alter table public.faq_public_event
  add column if not exists ip          text,
  add column if not exists ua          text,
  add column if not exists device      text,
  add column if not exists browser     text,
  add column if not exists referer     text,
  add column if not exists is_internal boolean,
  add column if not exists country     text,
  add column if not exists region      text,
  add column if not exists dwell_ms    integer;

comment on column public.faq_public_event.ip is 'アクセス元のIP。🚨 個人情報として扱う。2年で消える（purge-faq-public-event）';
comment on column public.faq_public_event.device is 'mobile / tablet / desktop。判定は faq_device_of() の1か所';
comment on column public.faq_public_event.is_internal is '社内からか。判定は faq_is_internal_ip()（app_settings.faq_internal_ips）';
comment on column public.faq_public_event.region is '都道府県。IPから引く必要があるので、この段では空のまま';
comment on column public.faq_public_event.dwell_ms is '画面を閉じるときに送られた滞在時間（ミリ秒）。送れないこともあるので null を許す';

-- 🚨 表の側にも「許す種類」の縛りがある。関数だけ直しても 23514 で弾かれる（2026-09-20 の検算で判明）。
--    足すのは 'leave'（画面を閉じたとき）だけ。ほかの5つは1文字も変えない
alter table public.faq_public_event drop constraint if exists faq_public_event_kind_check;
alter table public.faq_public_event add constraint faq_public_event_kind_check
  check (kind = any (array['page_view'::text, 'topic_view'::text, 'contact'::text, 'contact_click'::text, 'solved'::text, 'leave'::text]));

-- 滞在時間は 'leave' の行にしか入れない（ほかの種類に紛れ込むと集計が狂う）
alter table public.faq_public_event drop constraint if exists faq_public_event_dwell_only_leave;
alter table public.faq_public_event add constraint faq_public_event_dwell_only_leave
  check (dwell_ms is null or kind = 'leave');

-- ───────────────────────────────────────────────
-- 2. 社内とみなすIP（管理画面から変えられるように app_settings に置く）
--    🚨 初期値は空＝全部「社外」。会社のIPが分かってから入れる
-- ───────────────────────────────────────────────
insert into public.app_settings (key, value)
values ('faq_internal_ips', '{"ips": []}'::jsonb)
on conflict (key) do nothing;

-- ───────────────────────────────────────────────
-- 3. 判定は1か所に置く（画面にも集計にも同じものを使わせる）
-- ───────────────────────────────────────────────

-- 要求のヘッダーを1つ読む。🚨 読めなくても絶対に例外を投げない（お客様の画面を止めない）
create or replace function public.faq_request_header(p_name text)
returns text language plpgsql stable
set search_path to 'public', 'pg_temp'
as $fn$
declare v text;
begin
  select nullif(btrim(coalesce(current_setting('request.headers', true), '{}')::json ->> p_name), '') into v;
  return v;
exception when others then
  return null;
end;
$fn$;

-- 端末の判定。🚨 「Android で Mobile が付かない」＝タブレットが定番の見分け方
create or replace function public.faq_device_of(p_ua text)
returns text language sql immutable
as $fn$
  select case
    when p_ua is null or btrim(p_ua) = '' then null
    when p_ua ~* 'ipad|tablet|kindle|silk|playbook' then 'tablet'
    when p_ua ~* 'android' and p_ua !~* 'mobile'    then 'tablet'
    when p_ua ~* 'iphone|ipod|mobile|windows phone' then 'mobile'
    else 'desktop'
  end;
$fn$;

-- ブラウザの判定。🚨 並び順が大事（Edge も Chrome を名乗る・Chrome も Safari を名乗る）
create or replace function public.faq_browser_of(p_ua text)
returns text language sql immutable
as $fn$
  select case
    when p_ua is null or btrim(p_ua) = '' then null
    when p_ua ~* 'edg/'            then 'Edge'
    when p_ua ~* 'opr/|opera'      then 'Opera'
    when p_ua ~* 'samsungbrowser'  then 'Samsung'
    when p_ua ~* 'firefox|fxios'   then 'Firefox'
    when p_ua ~* 'crios|chrome'    then 'Chrome'
    when p_ua ~* 'safari'          then 'Safari'
    else 'その他'
  end;
$fn$;

-- 社内からか。app_settings の一覧と突き合わせる（1つのIPでも 192.168.0.0/24 のような範囲でも書ける）
create or replace function public.faq_is_internal_ip(p_ip text)
returns boolean language plpgsql stable
set search_path to 'public', 'pg_temp'
as $fn$
declare v_ip inet; v_item text; v_list text[];
begin
  if p_ip is null or btrim(p_ip) = '' then return null; end if;
  begin v_ip := p_ip::inet; exception when others then return null; end;

  select coalesce(array(select jsonb_array_elements_text(s.value -> 'ips')), '{}')
    into v_list from public.app_settings s where s.key = 'faq_internal_ips';
  if v_list is null or array_length(v_list, 1) is null then return false; end if;

  foreach v_item in array v_list loop
    v_item := btrim(v_item);
    continue when v_item = '';
    begin
      if v_ip <<= v_item::inet then return true; end if;
    exception when others then null;   -- 書き間違いの行は黙って飛ばす（判定を止めない）
    end;
  end loop;
  return false;
exception when others then
  return null;
end;
$fn$;

-- ───────────────────────────────────────────────
-- 4. 記録の関数を作り直す
--    🚨 引数が増えるので、同名の関数が2つできないよう**先に drop する**
--       （残すと PostgREST が PGRST203 で全部失敗する。2026-09-03 に踏んでいる）
--    🚨 デプロイ順は DB → 画面。古い画面は p_dwell_ms を送らないが、既定値があるので通る
-- ───────────────────────────────────────────────
drop function if exists public.faq_public_event_log(text, text, text, uuid, uuid, text, text, text);

create or replace function public.faq_public_event_log(
  p_kind text,
  p_reason text default null::text,
  p_channel text default null::text,
  p_topic_id uuid default null::uuid,
  p_answer_id uuid default null::uuid,
  p_school text default null::text,
  p_course text default null::text,
  p_session_id text default null::text,
  p_dwell_ms integer default null::integer
)
returns void
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_topic    uuid;
  v_answer   uuid;
  v_question text;
  v_n        integer;
  v_ip       text;
  v_ua       text;
begin
  -- 知らない種類は黙って捨てる（画面のバグで意味のない行を増やさない）
  -- 🚨 'leave'＝画面を閉じたときの滞在時間（2026-09-20 追加）
  if p_kind not in ('page_view','topic_view','contact','contact_click','solved','leave') then
    return;
  end if;

  -- 1日の上限。超えたら記録しないだけで、お客様の画面は止めない
  insert into public.faq_event_quota (day, n)
  values ((now() at time zone 'Asia/Tokyo')::date, 1)
  on conflict (day) do update set n = public.faq_event_quota.n + 1
  returning n into v_n;
  if v_n > 20000 then
    return;
  end if;

  -- 🚨 質問は「社外向けかつ公開中」のものだけ受け付ける。
  --    呼び出し側は誰でも叩けるので、社内向けQ&AのIDを渡されても記録しない
  --    （既存 faq_public_log と同じ考え方）。
  --    見つからなければ null にして、行そのものは残す（件数だけは失わない）
  if p_topic_id is not null then
    select t.id, left(t.question, 200)
      into v_topic, v_question
      from public.faq_topics t
     where t.id = p_topic_id
       and t.audience = 'public'
       and t.is_published = true;
  end if;

  -- 回答は「その質問にぶら下がっているもの」だけ受け付ける
  if p_answer_id is not null and v_topic is not null then
    select a.id into v_answer
      from public.faq_answers a
     where a.id = p_answer_id
       and a.topic_id = v_topic;
  end if;

  -- アクセス元の情報。🚨 画面からは受け取らない（偽れる値を信じない）。要求のヘッダーだけを見る
  --    Cloudflare を通るので cf-connecting-ip がいちばん確か。無ければ x-forwarded-for の先頭
  v_ip := coalesce(
            public.faq_request_header('cf-connecting-ip'),
            split_part(coalesce(public.faq_request_header('x-forwarded-for'), ''), ',', 1));
  v_ip := nullif(btrim(v_ip), '');
  v_ua := left(public.faq_request_header('user-agent'), 300);

  insert into public.faq_public_event
    (kind, reason, channel, topic_id, answer_id, topic_question, school, course, session_id,
     ip, ua, device, browser, referer, is_internal, country, dwell_ms)
  values
    (p_kind,
     -- 種類に合わない値は null に倒す（例外にして1件失うより、記録を残すほうを選ぶ）
     case when p_kind = 'contact'
           and p_reason in ('unsolved','search_nomatch','search_nohit','unknown','noanswer','load_error')
          then p_reason end,
     case when p_kind = 'contact_click' and p_channel in ('tel','form')
          then p_channel end,
     v_topic,
     v_answer,
     v_question,
     left(p_school, 50),
     left(p_course, 50),
     left(p_session_id, 64),
     left(v_ip, 64),
     v_ua,
     public.faq_device_of(v_ua),
     public.faq_browser_of(v_ua),
     left(public.faq_request_header('referer'), 300),
     public.faq_is_internal_ip(v_ip),
     left(public.faq_request_header('cf-ipcountry'), 8),
     -- 🚨 桁あふれと悪ふざけを防ぐ：0〜24時間だけ受け付ける
     case when p_kind = 'leave' and p_dwell_ms between 0 and 86400000 then p_dwell_ms end);
end;
$function$;

-- 🚨 この関数だけは anon（ログインしていないお客様）が呼ぶ。意図して開ける
grant execute on function public.faq_public_event_log(text, text, text, uuid, uuid, text, text, text, integer) to anon;
grant execute on function public.faq_public_event_log(text, text, text, uuid, uuid, text, text, text, integer) to authenticated;

-- 中で使う道具は anon に開けない（呼ぶ必要がない）
revoke execute on function public.faq_request_header(text)  from anon;
revoke execute on function public.faq_device_of(text)       from anon;
revoke execute on function public.faq_browser_of(text)      from anon;
revoke execute on function public.faq_is_internal_ip(text)  from anon;

-- ───────────────────────────────────────────────
-- 5. 集計（画面で1,000件ずつ読まない。DB側で数える）
-- ───────────────────────────────────────────────

-- 来た人の内訳。1本で「端末・社内社外・国・都道府県・ブラウザ・流入元・時間帯・曜日」を返す
create or replace function public.faq_public_visitor_summary(p_from timestamptz, p_to timestamptz)
returns table(dim text, value text, n bigint, sessions bigint)
language sql stable
set search_path to 'public', 'pg_temp'
as $fn$
  with e as (
    select * from public.faq_public_event
     where created_at >= p_from and created_at < p_to
  )
  select '端末', coalesce(device, '不明'), count(*), count(distinct session_id) from e group by 2
  union all
  select '社内/社外',
         case when is_internal then '社内' when is_internal is false then '社外' else '不明' end,
         count(*), count(distinct session_id) from e group by 2
  union all
  select '国', coalesce(country, '不明'), count(*), count(distinct session_id) from e group by 2
  union all
  select '都道府県', coalesce(region, '未調査'), count(*), count(distinct session_id) from e group by 2
  union all
  select 'ブラウザ', coalesce(browser, '不明'), count(*), count(distinct session_id) from e group by 2
  union all
  select '流入元',
         coalesce(nullif(regexp_replace(coalesce(referer, ''), '^https?://([^/]+).*$', '\1'), ''), '直接'),
         count(*), count(distinct session_id) from e group by 2
  union all
  select '時間帯', to_char(created_at at time zone 'Asia/Tokyo', 'HH24') || '時',
         count(*), count(distinct session_id) from e group by 2
  union all
  select '曜日',
         (array['日','月','火','水','木','金','土'])[extract(dow from created_at at time zone 'Asia/Tokyo')::int + 1],
         count(*), count(distinct session_id) from e group by 2;
$fn$;

-- 滞在時間。🚨 2つの測り方を合わせる（2026-09-20 ユーザー確定）
--   ① 同じ人（session_id）の最初と最後の操作の差 … 追加の記録が要らない。読んでいた時間は入らない
--   ② 画面を閉じるときに送られた実測（dwell_ms）… 正確だが、スマホでは送れないことがある
--   → 1人ぶんは「大きいほう」を採る。②が届かなくても①が残るので、数字が嘘にならない
create or replace function public.faq_public_dwell_summary(p_from timestamptz, p_to timestamptz)
returns table(sessions bigint, median_sec numeric, avg_sec numeric, over_1min bigint, measured bigint)
language sql stable
set search_path to 'public', 'pg_temp'
as $fn$
  with s as (
    select session_id,
           extract(epoch from (max(created_at) - min(created_at)))          as span_sec,
           coalesce(max(dwell_ms) filter (where kind = 'leave'), 0) / 1000.0 as leave_sec,
           count(*) filter (where kind = 'leave')                            as leaves
      from public.faq_public_event
     where created_at >= p_from and created_at < p_to
       and session_id is not null
     group by session_id
  ), t as (
    select greatest(span_sec, leave_sec) as sec, leaves from s
  )
  select count(*)::bigint,
         round(percentile_cont(0.5) within group (order by sec)::numeric, 1),
         round(avg(sec)::numeric, 1),
         count(*) filter (where sec >= 60)::bigint,
         count(*) filter (where leaves > 0)::bigint
    from t;
$fn$;

-- 🚨 集計は見せてよい人だけ（表の select と同じ can_edit_faq()）。anon には開けない
revoke execute on function public.faq_public_visitor_summary(timestamptz, timestamptz) from anon;
revoke execute on function public.faq_public_dwell_summary(timestamptz, timestamptz)   from anon;

-- ───────────────────────────────────────────────
-- 6. 掃除（🚨 記録を貯める仕組みには必ず掃除をセットで付ける）
--    faq_public_event は既存の purge-faq-public-event が24か月で消す（IPもこれで2年で消える）。
--    faq_query_log には掃除が無かったので、ここで足す
-- ───────────────────────────────────────────────
select cron.schedule(
  'purge-faq-query-log',
  '55 18 * * *',          -- 3:55 JST（既存の purge-faq-public-event の5分後にずらす）
  $cron$
    -- ① 期間で消す（24か月）
    delete from public.faq_query_log
     where created_at < now() - interval '24 months';

    -- ② 行数の上限。新しいものから20万行を残し、それより古いものを消す
    delete from public.faq_query_log
     where id in (
       select id from public.faq_query_log
        order by created_at desc
        offset 200000
     );
  $cron$
);

-- 戻し版（この migration を取り消すとき）:
--   select cron.unschedule('purge-faq-query-log');
--   drop function if exists public.faq_public_dwell_summary(timestamptz, timestamptz);
--   drop function if exists public.faq_public_visitor_summary(timestamptz, timestamptz);
--   drop function if exists public.faq_public_event_log(text,text,text,uuid,uuid,text,text,text,integer);
--   （そのうえで 2026-09-20 以前の8引数版を本番の実定義から戻す）
--   drop function if exists public.faq_is_internal_ip(text), public.faq_browser_of(text),
--                           public.faq_device_of(text), public.faq_request_header(text);
--   alter table public.faq_public_event
--     drop column ip, drop column ua, drop column device, drop column browser, drop column referer,
--     drop column is_internal, drop column country, drop column region, drop column dwell_ms;
--   delete from public.app_settings where key = 'faq_internal_ips';
