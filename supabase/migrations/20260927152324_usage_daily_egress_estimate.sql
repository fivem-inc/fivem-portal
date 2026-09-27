-- ============================================================
-- 2026-09-27  管理画面に「通信量（今月の見込み・目安）」を出すための記録（ユーザー確定 案A）
-- ============================================================
-- 背景：Supabase 無料枠の通信量（Egress 5 GB/月）が 90% に達した（docs/計画-自動更新の見直し.md）。
--   Supabase は通信量（GB）をプログラムから読む正式な方法を用意していない（管理画面の Usage だけ）。
--   そこで「画面からの問い合わせの回数」を毎晩記録し、1 回あたりの大きさ（目安）を掛けて今月の見込み GB を出す。
--   正確な値は Supabase の Usage で見る（管理画面にリンクを添える）。
--
-- 数えるもの：pg_stat_statements の「select set_config(…request.jwt…)」の calls
--   ＝ PostgREST（画面・Edge Function からの問い合わせ）の HTTP 1 回ごとに 1 回（本体の問い合わせ数と 1:1 で一致することを 2026-09-27 に実測）。
--   累計なので、毎晩の記録の差が「その日の回数」。累計がリセットされたら（stats_reset が変わる）その日からの数え直しとして扱う。
-- 1 回あたりの大きさ：app_settings 'usage_bytes_per_request'（無ければ 2600 バイト）。
--   2026-09-27 の実測（締め 8/29〜の 4.52 GB ÷ 同期間の推定 174 万回）から。自動更新の見直しで中身が変わるので、
--   Usage の実際の値と見比べて、ずれたらこの設定を直す（画面は触らなくてよい）。
-- 締めの日：app_settings 'usage_cycle_day'（無ければ 29 日。Supabase の請求の区切り＝毎月 29 日）
-- 🚨 記録を貯める仕組みなので、古い記録（120 日より前）は毎晩の記録のときに消す（CLAUDE.md の決まり）

create table if not exists public.usage_daily (
  day         date primary key,                     -- JST の日付（その日の終わりの時点の累計）
  http_calls  bigint not null,                      -- その時点の PostgREST の要求数の累計
  stats_reset timestamptz,                          -- 累計の起点（変わっていたらリセットされた）
  taken_at    timestamptz not null default now()
);
comment on table public.usage_daily is
  '通信量の目安のための毎晩の記録（PostgREST の要求数の累計）。record_usage_snapshot() が毎晩入れ、120 日より前は消す。画面は admin_usage_estimate() だけから読む';
alter table public.usage_daily enable row level security;   -- 読み書きの許可は作らない＝関数からだけ
revoke all on table public.usage_daily from anon, authenticated;

-- いまの累計（関数の中からだけ使う）
create or replace function public.usage_http_calls_total()
returns bigint
language sql
stable
security definer
set search_path = public, extensions
as $$
  select coalesce(sum(calls), 0)::bigint
    from pg_stat_statements
   where query like 'select set_config(%request.jwt%';
$$;
revoke execute on function public.usage_http_calls_total() from public;
revoke execute on function public.usage_http_calls_total() from anon;
revoke execute on function public.usage_http_calls_total() from authenticated;

-- 毎晩の記録（cron から）。同じ日に2回呼んでも1行（上書き）
create or replace function public.record_usage_snapshot()
returns void
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  insert into public.usage_daily (day, http_calls, stats_reset)
  values ((now() at time zone 'Asia/Tokyo')::date,
          public.usage_http_calls_total(),
          (select stats_reset from pg_stat_statements_info))
  on conflict (day) do update
    set http_calls = excluded.http_calls, stats_reset = excluded.stats_reset, taken_at = now();
  delete from public.usage_daily where day < (now() at time zone 'Asia/Tokyo')::date - 120;
end;
$$;
revoke execute on function public.record_usage_snapshot() from public;
revoke execute on function public.record_usage_snapshot() from anon;
revoke execute on function public.record_usage_snapshot() from authenticated;

-- 管理画面の見込み（管理者だけ）
create or replace function public.admin_usage_estimate()
returns json
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_now_ts     timestamptz := now();
  v_today      date := (now() at time zone 'Asia/Tokyo')::date;
  v_anchor     int;
  v_bytes      numeric;
  v_month1     date;
  v_start      date;
  v_end        date;
  v_base       public.usage_daily%rowtype;
  v_since      timestamptz;
  v_total      bigint;
  v_reset      timestamptz;
  v_calls      bigint;
  v_elapsed    numeric;
  v_cycle_days int;
begin
  if coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'admin' then
    raise exception '管理者だけが見られます' using errcode = '42501';
  end if;

  v_anchor := coalesce((select (value #>> '{}')::int from public.app_settings where key = 'usage_cycle_day'), 29);
  v_bytes  := coalesce((select (value #>> '{}')::numeric from public.app_settings where key = 'usage_bytes_per_request'), 2600);

  -- 締めの区切り（毎月 v_anchor 日。その日が無い月は月末）
  v_month1 := date_trunc('month', v_today)::date;
  v_start  := v_month1 + (least(v_anchor, extract(day from (v_month1 + interval '1 month - 1 day'))::int) - 1);
  if v_today < v_start then
    v_month1 := (v_month1 - interval '1 month')::date;
    v_start  := v_month1 + (least(v_anchor, extract(day from (v_month1 + interval '1 month - 1 day'))::int) - 1);
  end if;
  v_month1 := (date_trunc('month', v_start) + interval '1 month')::date;
  v_end    := v_month1 + (least(v_anchor, extract(day from (v_month1 + interval '1 month - 1 day'))::int) - 1);
  v_cycle_days := v_end - v_start;

  v_total := public.usage_http_calls_total();
  v_reset := (select stats_reset from pg_stat_statements_info);

  -- 起点：区切りの前日の終わりの記録。無ければ区切りの中でいちばん古い記録
  select * into v_base from public.usage_daily where day = v_start - 1;
  if found then
    v_since := (v_start::timestamp at time zone 'Asia/Tokyo');
  else
    select * into v_base from public.usage_daily where day >= v_start order by day limit 1;
    if not found then
      return json_build_object('status', 'collecting', 'cycle_start', v_start, 'cycle_end', v_end, 'limit_gb', 5);
    end if;
    v_since := v_base.taken_at;
  end if;

  -- 累計がリセットされていたら、リセットの時点からの数え直しとして扱う
  if v_base.stats_reset is distinct from v_reset or v_total < v_base.http_calls then
    v_calls := v_total;
    v_since := greatest(v_since, coalesce(v_reset, v_since));
  else
    v_calls := v_total - v_base.http_calls;
  end if;

  v_elapsed := extract(epoch from (v_now_ts - v_since)) / 86400.0;
  if v_elapsed < 0.5 then
    return json_build_object('status', 'collecting', 'cycle_start', v_start, 'cycle_end', v_end, 'limit_gb', 5, 'measured_since', v_since);
  end if;

  return json_build_object(
    'status', 'ok',
    'cycle_start', v_start,
    'cycle_end', v_end,
    'cycle_days', v_cycle_days,
    'measured_since', v_since,
    'elapsed_days', round(v_elapsed, 1),
    'requests_so_far', v_calls,
    'so_far_gb', round(v_calls * v_bytes / 1e9, 2),
    'projected_gb', round(v_calls / v_elapsed * v_cycle_days * v_bytes / 1e9, 2),
    'bytes_per_request', v_bytes,
    'limit_gb', 5
  );
end;
$$;
revoke execute on function public.admin_usage_estimate() from public;
revoke execute on function public.admin_usage_estimate() from anon;
grant  execute on function public.admin_usage_estimate() to authenticated;

-- 毎晩 23:59 JST（14:59 UTC）に記録
do $$
begin
  if exists (select 1 from cron.job where jobname = 'usage-daily-snapshot') then
    perform cron.unschedule('usage-daily-snapshot');
  end if;
end;
$$;
select cron.schedule('usage-daily-snapshot', '59 14 * * *', $cron$select public.record_usage_snapshot()$cron$);

-- 今日の分を1回入れておく（次の締め 9/29 の起点は 9/28 の夜の記録になる）
select public.record_usage_snapshot();

-- 確認用：
--   select has_function_privilege('anon', 'public.admin_usage_estimate()', 'execute');          -- false
--   select has_function_privilege('authenticated', 'public.record_usage_snapshot()', 'execute'); -- false
--   select * from public.usage_daily;
