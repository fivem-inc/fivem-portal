-- 勤怠カレンダー（アプリ内 /calendar）に残業を表示するための取得関数
--
-- 【背景】
-- 受理された残業は Google カレンダー（ファイブM共有）には出ていたが、
-- アプリ内の勤怠カレンダーには1行も出ていなかった。
-- CalendarPage が overtime_reports を一度も読んでいなかったため。
-- マネージャーのテストで「残業が勤怠カレンダーに出ない」と指摘された件への対応。
--
-- 【設計の要点】
-- ・🚨 reason（理由）は絶対に返さない。
--   「体調不良で早退」のような内容が他の人に見えてしまうため。
--   返すのは「誰が・いつ・何を・何時から何時まで・どの校で」だけ。
--
-- ・🚨 種別ごとの掲載可否（遅刻・早退は本人が選んだときだけ載せる等）は SQL では判定しない。
--   同じ判定表が client/src/lib/overtimeTypes.ts の OT_CALENDAR と
--   supabase/functions/gcal-sync/index.ts の OVERTIME_TYPES に既に2箇所ある。
--   ここに3箇所目を作ると「片方だけ直して食い違う」事故になる。
--   SQL では「本人が明示的に載せないと決めたもの（show_on_calendar = false）」だけを外し、
--   残りの判定は画面側の willShowOnCalendar に任せる。
--   → SQL が緩すぎて余分に返しても画面側で落ちるだけ（安全側）。
--
-- ・entry_type = 'manual' に限定する。
--   休暇由来の自動計上（leave_auto）まで返すと、休暇の予定と同じ日に二重表示になる。
--
-- ・閲覧できるのは勤怠カレンダーを開ける人（leave_calendar 権限）だけ。
--   役職の上下による制限はかけない。
--   Google カレンダーには既に役職に関係なく全員分が出ているため、
--   ここで隠すと「Google では見えるのにアプリでは見えない」という食い違いになる。
--   （2026-08-21 ユーザー判断）

create or replace function public.calendar_overtime_events(p_from date, p_to date)
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
  end_min int
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
    s.end_min
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
    -- 受理後のものだけ（gcal-sync の同期条件と同じ）
    and r.status in ('request_confirmed', 'reported', 'confirmed')
    -- 本人が「載せない」と決めたものは返さない（null＝未指定はここでは落とさない）
    and r.show_on_calendar is distinct from false
    and coalesce(array_length(r.application_types, 1), 0) > 0;
$$;

comment on function public.calendar_overtime_events(date, date) is
  '勤怠カレンダー用の残業取得。理由(reason)は返さない。種別ごとの掲載可否は画面側の willShowOnCalendar で判定する';

-- 🚨 anon（未ログイン）からは明示的に外す。
--    Supabase は新しい関数に anon の実行権限を自動で付けるため、
--    `revoke ... from public` だけでは外れない（実測で anon が呼べる状態だった）。
--    関数の中で has_feature_permission を見ているのでデータは漏れないが、
--    呼べる必要のない入口は塞いでおく。
revoke execute on function public.calendar_overtime_events(date, date) from public;
revoke execute on function public.calendar_overtime_events(date, date) from anon;
grant  execute on function public.calendar_overtime_events(date, date) to authenticated;
