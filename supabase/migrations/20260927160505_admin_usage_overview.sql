-- ============================================================
-- 2026-09-27  管理画面の「使用量」の表に出す値（ユーザー確定：右上の［使用量］ボタンから開く表）
-- ============================================================
-- 足すもの（どちらも管理者だけ・42501）：
--   ・日ごとの問い合わせ回数（直近 14 日）… usage_daily の毎晩の記録の差。自動更新の見直しの効きを見る（1 週間の判断に使う）
--   ・Edge Function の呼び出しの見込み（定期処理の分）… 直近 24 時間に cron が Edge Function を呼んだ回数 × 締めの区切りの日数
--     （無料枠 50 万回/月。画面から呼ぶ分は数えられないので「定期処理の分」と書く。2026-09-27 時点で 1 日約 3,000 回＝月約 9 万回）
-- 🚨 cron.job_run_details は毎日掃除される（purge-cron-history-daily）が、24 時間ぶんは残っている（2026-09-27 実測：9/19 からある）

create or replace function public.admin_usage_overview()
returns json
language plpgsql
stable
security definer
set search_path = public, extensions
as $$
declare
  v_ef_24h  bigint;
  v_daily   json;
  v_anchor  int;
  v_today   date := (now() at time zone 'Asia/Tokyo')::date;
  v_month1  date;
  v_start   date;
  v_end     date;
begin
  if coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '') <> 'admin' then
    raise exception '管理者だけが見られます' using errcode = '42501';
  end if;

  select count(*) into v_ef_24h
    from cron.job_run_details d join cron.job j on j.jobid = d.jobid
   where j.command like '%functions/v1/%'
     and d.start_time > now() - interval '1 day';

  -- 締めの区切りの日数（admin_usage_estimate と同じ決め方）
  v_anchor := coalesce((select (value #>> '{}')::int from public.app_settings where key = 'usage_cycle_day'), 29);
  v_month1 := date_trunc('month', v_today)::date;
  v_start  := v_month1 + (least(v_anchor, extract(day from (v_month1 + interval '1 month - 1 day'))::int) - 1);
  if v_today < v_start then
    v_month1 := (v_month1 - interval '1 month')::date;
    v_start  := v_month1 + (least(v_anchor, extract(day from (v_month1 + interval '1 month - 1 day'))::int) - 1);
  end if;
  v_month1 := (date_trunc('month', v_start) + interval '1 month')::date;
  v_end    := v_month1 + (least(v_anchor, extract(day from (v_month1 + interval '1 month - 1 day'))::int) - 1);

  -- 日ごとの回数：前の日の記録との差（累計がリセットされた日は、その日の累計をそのまま使う）
  select json_agg(json_build_object('day', d.day, 'requests', d.requests) order by d.day desc) into v_daily
    from (
      select u.day,
             case when p.day is null then null
                  when u.stats_reset is distinct from p.stats_reset or u.http_calls < p.http_calls then u.http_calls
                  else u.http_calls - p.http_calls end as requests
        from public.usage_daily u
        left join public.usage_daily p on p.day = u.day - 1
       where u.day >= v_today - 14
    ) d;

  return json_build_object(
    'ef_cron_runs_24h', v_ef_24h,
    'ef_projected_cycle', v_ef_24h * (v_end - v_start),
    'ef_limit', 500000,
    'daily', coalesce(v_daily, '[]'::json)
  );
end;
$$;
revoke execute on function public.admin_usage_overview() from public;
revoke execute on function public.admin_usage_overview() from anon;
grant  execute on function public.admin_usage_overview() to authenticated;

-- 確認用：
--   select has_function_privilege('anon', 'public.admin_usage_overview()', 'execute');  -- false
