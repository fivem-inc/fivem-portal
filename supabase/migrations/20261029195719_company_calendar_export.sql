-- 2026-10-29 班分けのツールへ渡す「会社カレンダー（休館日）」の一覧（ユーザー確定：休館日だけ）
-- RPA の PC が staff_absence_export と同じ毎時の実行で呼び、NAS に「カレンダー_最新.csv」を置く。
-- ・合言葉は staff_export_tokens と同じもの（見出し x-export-token・SHA-256 で照合）
--   🚨 照合の書き方は staff_absence_export と同じ。片方を変えたらもう片方も
-- ・今日から60日先まで。会社カレンダーは全校共通なので校名は「全校」。タイトル・時間は持っていないので空
-- ・種類は紙の全社年間カレンダーの凡例と同じ言い方（client/src/lib/breakCalc.ts の CALENDAR_KIND_LABELS）
--   🚨 会社カレンダーの種類を足したら、ここの対応も足す（足さないと「その他」で出る）
-- ・列：書き出した時刻,日付,校名,種類,タイトル,時間,メモ（UTF-8・CRLF。BOM は RPA の側で付ける）

create or replace function public.company_calendar_export()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_token text := nullif(current_setting('request.headers', true), '')::jsonb ->> 'x-export-token';
  v_id uuid;
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_until date := (now() at time zone 'Asia/Tokyo')::date + 60;
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
$$;

comment on function public.company_calendar_export() is
  '班分けのツールへ渡す会社カレンダー（休館日）の CSV（今日から60日・見出し x-export-token の合言葉が合うときだけ）。RPA の PC が毎時呼ぶ';

-- 呼べるのは anon だけ（staff_absence_export と同じ）
revoke all on function public.company_calendar_export() from public;
revoke all on function public.company_calendar_export() from authenticated;
grant execute on function public.company_calendar_export() to anon;
