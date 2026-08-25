-- 勤怠カレンダーに「申請中（まだ上長が受理していない）残業」も出す
--
-- 【背景】
-- 残業は「事前申請 → 上長が受理 → 実績報告 → 確認」の流れだが、
-- 受理されないと本人が実績報告できず、しかも未受理のまま勤務日を過ぎても
-- 本人にも上長にも何も出ないため、放置されるケースがあった。
-- 対応として「受理されていなくても予定を共有し、実績報告もできる」ようにする。
-- カレンダーにも申請の段階から載せる（Googleカレンダー側は gcal-sync で同時に対応）。
--
-- 【この migration ですること】
-- ① 取得対象の status に 'requested'（申請中）を追加
-- ② 画面で「申請中」と分かるように status を返す列に追加
--
-- 🚨 ②のために返す列が増えるため create or replace では置き換えられない
--    （PostgreSQL は既存関数の戻り値の型を変更できない）。drop してから作り直す。
--    依存（view・他の関数）が無いことは本番で実測済み（0件）。
--    drop 中の数十秒だけ、勤怠カレンダーを開いた人がエラーになる可能性がある。
--
-- 🚨 この本文は「本番の実定義（pg_get_functiondef）」から起こしている。
--    リポジトリのファイルが最後に適用された版とは限らないため。
--
-- 🚨 種別ごとの掲載可否（遅刻・早退は本人が選んだときだけ載せる等）は
--    ここでは判定しない。判定表は client/src/lib/overtimeTypes.ts の OT_CALENDAR と
--    supabase/functions/gcal-sync/index.ts の OVERTIME_TYPES に既に2箇所ある。
--    3箇所目を作ると「片方だけ直して食い違う」事故になるため、
--    SQL は「本人が明示的に載せないと決めたもの」だけを外し、残りは画面側の
--    willShowOnCalendar に任せる（SQL が緩くて余分に返しても画面側で落ちる＝安全側）。

drop function if exists public.calendar_overtime_events(date, date);

create function public.calendar_overtime_events(p_from date, p_to date)
returns table (
  id uuid,
  applicant_id uuid,
  name text,
  work_date date,
  application_types text[],
  is_post_hoc boolean,
  show_on_calendar boolean,
  location text,
  start_min int,
  end_min int,
  status text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    r.id,
    r.applicant_id,
    p.name,
    r.work_date,
    r.application_types,
    r.is_post_hoc,
    r.show_on_calendar,
    r.location,
    s.start_min,
    s.end_min,
    -- 画面で「申請中」バッジを出すために使う。理由(reason)は返さない方針は変えない
    r.status
  from overtime_reports r
  join profiles p on p.id = r.applicant_id
  left join lateral (
    -- 実績があれば実績、なければ予定の時間帯（gcal-sync のタイトル生成と同じ考え方）
    select min(g.start_min)::int as start_min,
           max(g.end_min)::int   as end_min
    from overtime_report_segments g
    where g.report_id = r.id
      and g.phase = case
        when exists (
          select 1 from overtime_report_segments a
          where a.report_id = r.id and a.phase = 'actual'
        ) then 'actual' else 'planned'
      end
  ) s on true
  where has_feature_permission('leave_calendar')
    and r.work_date between p_from and p_to
    and r.entry_type = 'manual'
    -- 申請済みのもの（gcal-sync の同期条件と同じ）。
    -- 'requested'（申請中）を含めるのが今回の変更。差し戻し・取消はここで落ちる
    and r.status in ('requested', 'request_confirmed', 'reported', 'confirmed')
    -- 本人が「載せない」と決めたものは返さない（null＝未指定はここでは落とさない）
    and r.show_on_calendar is distinct from false
    and coalesce(array_length(r.application_types, 1), 0) > 0;
$$;

comment on function public.calendar_overtime_events(date, date) is
  '勤怠カレンダー用の残業取得。理由(reason)は返さない。種別ごとの掲載可否は画面側の willShowOnCalendar で判定する。status は「申請中」表示の判定に使う';

-- 🚨 anon（未ログイン）からは明示的に外す。
--    Supabase は新しい関数に anon の実行権限を自動で付けるため、
--    `revoke ... from public` だけでは外れない（実測で anon が呼べる状態だった）。
--    drop → create で権限は作り直しになるため、ここで必ず付け直す。
revoke execute on function public.calendar_overtime_events(date, date) from public;
revoke execute on function public.calendar_overtime_events(date, date) from anon;
grant  execute on function public.calendar_overtime_events(date, date) to authenticated;
