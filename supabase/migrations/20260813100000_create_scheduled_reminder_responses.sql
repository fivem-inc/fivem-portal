-- 定期リマインドの対応記録（誰が「完了しました」を押したか）
--
-- 【なぜ専用テーブルを作るか】
-- 当初は notifications.banner_dismissed に記録する案だったが、次の理由で成立しない：
--   1. 通知は「既読になってから30日」で自動削除される。消える条件が「本人がベルを開いたか」
--      なので、押した人（＝アプリをよく開く人）の記録から先に消え、押していない人の記録が残る。
--      時間が経つほど「未対応者だけが残った、実態と逆さまの集計」になり、分母も狂う。
--   2. notifications は本人が列を制限なく UPDATE できるため、自分を未対応一覧から消せてしまう。
-- そこで「通知＝バナーを出すための一時ログ（30日で消えてよい）」と
-- 「対応記録＝ずっと残す台帳」を別のテーブルに分ける。
--
-- 【分母を確定させるため、配信時に対象者全員分の行を作る】
-- 押した人だけ行を作る方式にすると「何人に配ったか」が後から分からなくなる。

create table if not exists public.scheduled_reminder_responses (
  id            uuid primary key default gen_random_uuid(),
  reminder_id   uuid not null references public.board_scheduled_reminders(id) on delete cascade,
  delivered_on  date not null,                       -- 配信日（JST）。月次でも週次でも1回の配信を識別できる
  user_id       uuid not null references auth.users(id) on delete cascade,
  -- 🚨 null を使わず 'pending' を既定にする。null だと PostgREST の .neq が その行を拾えない
  status        text not null default 'pending' check (status in ('pending','done','snoozed')),
  snooze_until  timestamptz,
  responded_at  timestamptz,
  created_at    timestamptz not null default now(),
  unique (reminder_id, delivered_on, user_id)
);

-- unique制約の先頭列は reminder_id なので、バナーの「自分の未対応」検索には使えない。
-- RLS の述語（user_id = auth.uid()）が全行に当たるため別途用意する
create index if not exists idx_srr_user_status
  on public.scheduled_reminder_responses (user_id, status);

alter table public.scheduled_reminder_responses enable row level security;

-- 閲覧は本人のみ。管理者は下の集計関数（SECURITY DEFINER）経由で見る。
-- 🚨 INSERT/UPDATE/DELETE のポリシーは意図的に作らない。
--    書き込めるのは配信処理（service_role）と下の RPC だけ＝本人が記録を細工できない。
create policy "srr_select_own"
  on public.scheduled_reminder_responses
  for select to authenticated
  using (user_id = auth.uid());


-- 本人が「完了しました」「後で」を押したときの記録
create or replace function public.respond_scheduled_reminder(p_id uuid, p_status text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_snooze timestamptz;
begin
  if p_status not in ('done', 'snoozed') then
    raise exception '不正な値です';
  end if;

  if p_status = 'snoozed' then
    -- 「明日の朝9時」。ボタンのラベル（後で・明日の朝また表示）と一致させる。
    -- 端末の時計ではなくJSTで決めるので、どの端末から押しても同じ時刻になる
    v_snooze := (((now() at time zone 'Asia/Tokyo')::date + 1) + time '09:00') at time zone 'Asia/Tokyo';
  end if;

  update public.scheduled_reminder_responses
     set status       = p_status,
         snooze_until = v_snooze,
         -- 「対応した日時」なので done のときだけ入れる（後でを押した時刻で埋めない）
         responded_at = case when p_status = 'done' then now() else responded_at end
   where id = p_id
     and user_id = auth.uid()
     and status in ('pending', 'snoozed');   -- 一度 done にしたものは巻き戻さない

  if not found then
    raise exception '対象が見つかりません';
  end if;
end;
$$;

revoke all on function public.respond_scheduled_reminder(uuid, text) from public;
grant execute on function public.respond_scheduled_reminder(uuid, text) to authenticated;


-- 管理画面の対応状況（配信ごとに 何人中何人が押したか＋まだ押していない人の名前）
--
-- 🚨 集計は必ずこの関数を通す。管理者でも他人の記録は直接読めない（RLSは本人のみ）ため、
--    画面から数えると「自分の分だけ」になって静かに嘘の数字が出る。
--    返すのは件数と名前だけで、通知の中身は返さない。
create or replace function public.scheduled_reminder_status(
  p_reminder_id uuid,
  p_dates int default 3,     -- さかのぼる配信の回数
  p_names int default 10     -- 名前を出す上限（残りは pending_count との差で「他N人」と表示する）
)
returns table (
  delivered_on   date,
  target_count   int,
  done_count     int,
  pending_count  int,
  pending_names  text[]
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce((auth.jwt() -> 'app_metadata' ->> 'role'), '') <> 'admin' then
    raise exception '権限がありません';
  end if;

  return query
  with target_dates as (
    select r.delivered_on as d
    from public.scheduled_reminder_responses r
    where r.reminder_id = p_reminder_id
    group by r.delivered_on
    order by r.delivered_on desc
    limit greatest(p_dates, 1)
  )
  select
    t.d,
    count(*)::int,
    count(*) filter (where r.status = 'done')::int,
    count(*) filter (where r.status <> 'done')::int,
    coalesce(
      (array_agg(coalesce(p.name, '(不明)') order by p.name)
         filter (where r.status <> 'done'))[1:greatest(p_names, 1)],
      '{}'::text[]
    )
  from target_dates t
  join public.scheduled_reminder_responses r
    on r.reminder_id = p_reminder_id and r.delivered_on = t.d
  left join public.profiles p on p.id = r.user_id
  group by t.d
  order by t.d desc;
end;
$$;

revoke all on function public.scheduled_reminder_status(uuid, int, int) from public;
grant execute on function public.scheduled_reminder_status(uuid, int, int) to authenticated;
