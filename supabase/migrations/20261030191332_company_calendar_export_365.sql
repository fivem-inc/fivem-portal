-- 班分けのツールへの会社カレンダーの書き出しを「今日から60日」→「今日から365日」に（2026-10-30・班分けのツールからの依頼）
-- 本番の実定義から起こし、v_until の 60 を 365 にしただけ。列・種類の文字・権限は変えていない
CREATE OR REPLACE FUNCTION public.company_calendar_export()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_token text := nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-export-token';
  v_id uuid;
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_until date := (now() at time zone 'Asia/Tokyo')::date + 365;
  v_now text := to_char(now() at time zone 'Asia/Tokyo', 'YYYY/MM/DD HH24:MI');
  v_body text;
begin
  if v_token is null or length(v_token) < 32 then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select id into v_id from staff_export_tokens
   where token_sha256 = encode(sha256(convert_to(v_token, 'UTF8')), 'hex') and revoked_at is null;
  if v_id is null then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  update staff_export_tokens set last_used_at = now() where id = v_id;

  with rows as (
    select c.date as d,
           array[
             v_now,
             to_char(c.date, 'YYYY/MM/DD'),
             '全校',
             case c.kind
               when 'closed_all' then '休館日・全社員休み'
               when 'work_on_closed' then '休館日・社員出勤日'
               when 'work_on_closed_encouraged' then '休館日・社員出勤日（有休奨励日）'
               else 'その他'
             end,
             '',
             '',
             coalesce(c.note, '')
           ] as f
      from company_calendar c
     where c.date between v_today and v_until
  ),
  lines as (
    select d,
           (select string_agg(case when x ~ '[",\r\n]' then '"' || replace(x, '"', '""') || '"' else x end, ',' order by i)
              from unnest(f) with ordinality as u(x, i)) as line
      from rows
  )
  select string_agg(line, E'\r\n' order by d) into v_body from lines;

  return '書き出した時刻,日付,校名,種類,タイトル,時間,メモ' || E'\r\n'
         || coalesce(v_body || E'\r\n', '');
end;
$function$

;
