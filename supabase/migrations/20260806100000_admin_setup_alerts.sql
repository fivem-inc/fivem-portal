-- 管理者の「入力もれ」を知らせる仕組み
--
-- きっかけ：年間カレンダーの登録を忘れると、休日出勤が通常勤務と判定されて残業が付かない。
-- シフトの切り替え時期（4/16・10/16）も、見直しを忘れると古いシフトのまま計算される。
--
-- 🚨 判定はこの関数1本に集約する。
--    ナビと管理タブのバッジ（クライアント）と、週1回の通知（Edge Function）の
--    両方がここを呼ぶ。条件を2か所に書くと必ず食い違うため。
--    しきい値や時期を変えるときも、ここだけ直せばよい。

create or replace function admin_setup_alerts()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_today      date := (now() at time zone 'Asia/Tokyo')::date;
  v_month      int  := extract(month from v_today)::int;
  v_day        int  := extract(day from v_today)::int;
  v_year       int  := extract(year from v_today)::int;
  v_next_year  int;
  v_cal_count  int;
  v_alerts     jsonb := '[]'::jsonb;
  -- 次年度カレンダーが「登録済み」とみなす最低件数。
  -- 年間の休館日は数十日あるため、これを下回っていれば入れ忘れとみなす
  c_calendar_min constant int := 10;
begin
  -- ① 次年度の会社カレンダー未登録
  --    紙の年間カレンダーは11月頃に決まるため、12月から翌3月まで催促する。
  --    登録が進んで10件を超えれば自動的に止まる（対応すれば消えるバッジ）
  if v_month = 12 or v_month <= 3 then
    v_next_year := case when v_month = 12 then v_year + 1 else v_year end;
    select count(*) into v_cal_count
      from company_calendar
      where date >= make_date(v_next_year, 1, 1)
        and date <= make_date(v_next_year, 12, 31);

    if v_cal_count < c_calendar_min then
      v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
        'key',    'company_calendar',
        'title',  v_next_year || '年の会社カレンダーが登録されていません',
        'detail', '登録済み ' || v_cal_count || '件。管理画面 → 残業管理 → 会社カレンダー から登録してください',
        'link',   '/admin?tab=overtime_admin&section=calendar'
      ));
    end if;
  end if;

  -- ② シフトの見直し時期
  --    4/16・10/16 からシフトが変わることが多いため、その前月の下旬に確認を促す。
  --    ⚠️ 「変更が必要かどうか」はシステムには判断できないので、条件は付けず時期だけで出す。
  --    そのためバッジには使わない（対応しても消せないため）。通知のみで使う。
  if (v_month = 3 or v_month = 9) and v_day >= 21 then
    v_alerts := v_alerts || jsonb_build_array(jsonb_build_object(
      'key',    'shift_review',
      'title',  '通常シフトの見直し時期です',
      'detail', case when v_month = 3 then '4月16日' else '10月16日' end
                || 'からのシフトに変更はありませんか。管理画面 → 残業管理 → 通常シフト で確認できます',
      'link',   '/admin?tab=overtime_admin&section=patterns'
    ));
  end if;

  return v_alerts;
end;
$$;

-- バッジ表示のためクライアントからも呼ぶ。
-- 中身は「登録件数」と「時期」だけで個人情報を含まないため、認証済みユーザーに実行を許可する。
-- （画面側では管理者・社長にしかバッジを出さない）
grant execute on function admin_setup_alerts() to authenticated;
