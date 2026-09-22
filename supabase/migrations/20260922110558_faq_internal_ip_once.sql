-- FAQ集計：会社のIPの一覧を「1行ごとに読む」のをやめる（2026-09-22 ユーザー承認）
--
-- シニアエンジニアのレビューの指摘。本番の pg_get_functiondef から起こしている。
--
-- 【何が問題だったか】
--   `faq_public_visitor_summary` は CTE の select リストで
--     coalesce(public.faq_is_internal_ip(ip), is_internal)
--   と書いており、`faq_is_internal_ip` は **呼ばれるたびに app_settings を1回 SELECT する**。
--   つまり **期間内の全行ぶん、設定を読み直していた**。しかも「社内/社外」以外の7つの軸しか
--   使わない行にも計算が走る。
--   🚨 1日の上限が20,000件・保持が24か月なので、理論上の最大は約1,460万行。
--      「年ごと」を押したときにタイムアウトに当たる。
--   🚨 **いまのデータ量では実害は出ていない**（記録は全消ししたばかりで0件）。
--      「今すぐ壊れている問題」ではなく「放っておくと必ず当たる問題」として直す。
--
-- 【直し方】
--   ・判定の中身（どのIPが社内か）は **faq_ip_in_list(ip, 一覧) に切り出す**。この関数は表を読まない
--   ・`faq_public_visitor_summary` は **一覧を CTE で1回だけ読み**、行ごとにはその配列を渡すだけにする
--   ・`faq_is_internal_ip(ip)` は残す（もう1つの呼び出し元 `faq_public_event_log` が使っている。
--     あちらは1件の記録につき1回なので問題ない）。中身は新しい関数に委ねる
--     🚨 これで「どのIPが社内か」の判定は**1か所だけ**になる
--
-- 🚨 通す・通さないの結果は1つも変えていない（null／false／true の出し分けの順番もそのまま）。

-- ─────────────────────────────────────────
-- 1. 判定の中身（表を読まない）
-- ─────────────────────────────────────────
create or replace function public.faq_ip_in_list(p_ip text, p_list text[])
returns boolean
language plpgsql
immutable
set search_path to 'public', 'pg_temp'
as $function$
declare v_ip inet; v_item text;
begin
  if p_ip is null or btrim(p_ip) = '' then return null; end if;
  begin v_ip := p_ip::inet; exception when others then return null; end;
  if p_list is null or array_length(p_list, 1) is null then return false; end if;

  foreach v_item in array p_list loop
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
$function$;

comment on function public.faq_ip_in_list(text, text[]) is
  'そのIPが一覧のどれかに入るか。🚨 表を読まないので、行ごとに呼んでも設定を読み直さない。'
  'null＝IPが無い・読めない／false＝一覧に無い／true＝社内';

revoke execute on function public.faq_ip_in_list(text, text[]) from public, anon;
grant  execute on function public.faq_ip_in_list(text, text[]) to authenticated, service_role;

-- ─────────────────────────────────────────
-- 2. 1件だけ判定するとき（記録するときに使う）
-- ─────────────────────────────────────────
-- 🚨 中身は上に委ねる。判定を2か所に書かない
create or replace function public.faq_is_internal_ip(p_ip text)
returns boolean
language plpgsql
stable
set search_path to 'public', 'pg_temp'
as $function$
declare v_list text[];
begin
  select coalesce(array(select jsonb_array_elements_text(s.value -> 'ips')), '{}')
    into v_list from public.app_settings s where s.key = 'faq_internal_ips';
  return public.faq_ip_in_list(p_ip, v_list);
exception when others then
  return null;
end;
$function$;

-- ─────────────────────────────────────────
-- 3. 集計：一覧は1回だけ読む
-- ─────────────────────────────────────────
-- 🚨 本番の実定義から起こした。変えたのは
--    ・cfg の CTE を足したこと
--    ・faq_is_internal_ip(ip) → faq_ip_in_list(ip, (select ips from cfg)) に替えたこと
--    の2点だけ。8つの軸の中身は1文字も変えていない
create or replace function public.faq_public_visitor_summary(p_from timestamp with time zone, p_to timestamp with time zone)
returns table(dim text, value text, n bigint, sessions bigint)
language sql
stable
set search_path to 'public', 'pg_temp'
as $function$
  with cfg as (
    -- 🚨 会社のIPの一覧はここで**1回だけ**読む（行ごとに読み直さない）
    select coalesce(array(select jsonb_array_elements_text(s.value -> 'ips')), '{}')::text[] as ips
      from public.app_settings s where s.key = 'faq_internal_ips'
  ),
  e as (
    select ev.*,
           -- 🚨 いまの一覧で判定し直す。IPが無い行だけ記録時の値に頼る
           coalesce(public.faq_ip_in_list(ev.ip, (select ips from cfg)), ev.is_internal) as internal_now
      from public.faq_public_event ev
     where ev.created_at >= p_from and ev.created_at < p_to
  )
  select '端末', coalesce(device, '不明'), count(*), count(distinct session_id) from e group by 2
  union all
  select '社内/社外',
         case when internal_now then '社内' when internal_now is false then '社外' else '不明' end,
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
$function$;

-- ─────────────────────────────────────────
-- 取り消すとき
-- ─────────────────────────────────────────
--   🚨 faq_is_internal_ip と faq_public_visitor_summary を、この migration の前の実定義
--      （20260920105731 の版）に戻したうえで
--   drop function if exists public.faq_ip_in_list(text, text[]);
