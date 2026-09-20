-- 「社内か社外か」を、集計するときに判定し直す（2026-09-20・同日の設計の見直し）
--
-- 🚨 なぜ直すか：`20260920105246` では「記録するときに判定」していた。
--    会社のIPはこれから登録するので、**いまの記録は全部「社外」で固定されてしまう**。
--    あとから会社のIPを入れても過去に遡らない＝「社内からのアクセスは0件」と嘘をつき続ける。
--    → 集計のたびに、いまの一覧（app_settings.faq_internal_ips）で判定し直す。
--      IPが残っていないときだけ、記録時の判定（is_internal）を使う。
-- 🚨 列 is_internal は残す（記録した時点でどう判定したかの控え）。

create or replace function public.faq_public_visitor_summary(p_from timestamptz, p_to timestamptz)
returns table(dim text, value text, n bigint, sessions bigint)
language sql stable
set search_path to 'public', 'pg_temp'
as $fn$
  with e as (
    select *,
           -- 🚨 いまの一覧で判定し直す。IPが無い行だけ記録時の値に頼る
           coalesce(public.faq_is_internal_ip(ip), is_internal) as internal_now
      from public.faq_public_event
     where created_at >= p_from and created_at < p_to
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
$fn$;

revoke execute on function public.faq_public_visitor_summary(timestamptz, timestamptz) from anon;
