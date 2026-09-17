-- ============================================================
-- 2026-09-17  残業申請のメモ（本人だけが見る・申請の前に書いておく）
-- ============================================================
-- きっかけ：スタッフの意見「朝遅刻したが、まだ申請はできない。いったんメモを保存して、
-- あとでそれを使って申請したい」。設計は docs/計画-残業申請メモ.md がすべて。
--
-- 🚨 本人だけが見る（2026-09-17 ユーザー確定）。上長・管理者にも見せない
--    （保守が必要なときは service_role で見る。overtime_plan_items と同じ扱い）。
-- 🚨 メモは申請ではない。申請画面に内容を入れるだけで、送信は本人が申請画面で行う。
-- 🚨 貯める仕組みなので、掃除（毎晩）と上限（1人20件）をセットで作る。

create table if not exists public.overtime_memos (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users(id) on delete cascade,
  -- 何があった？（思い出すための目印。申請の種別を決めるものではない）
  --   tardiness=遅刻 / early_start=早出 / early_leave=早退 / overtime=残業 / holiday_work=休日出勤 /
  --   day_off=調整休・振替・欠勤 / location_change=勤務地変更 /
  --   missed_clock=打刻忘れ / clock_only=打刻ズレ / other=その他
  -- 🚨 「打刻忘れ」と「打刻ズレ」は別のもの（2026-09-17 ユーザー確定「両方残す」）。
  --    どちらも申請画面では残業ページの「打刻ズレ」（clock_only）の入力に入る
  kind        text not null check (kind in (
                'tardiness', 'early_start', 'early_leave', 'overtime', 'holiday_work',
                'day_off', 'location_change', 'missed_clock', 'clock_only', 'other')),
  kind_other  text check (kind_other is null or char_length(kind_other) <= 100),
  target_date date not null,
  -- 時刻。「まだ分からない」は null。どちらを使うかは kind で決まる（lib/overtimeMemo.ts の1か所）
  --   遅刻・早出 → time_start（出勤）／早退・残業 → time_end（退勤）／休日出勤 → 両方／
  --   打刻忘れ・打刻ズレ → time_start=出勤の打刻・time_end=退勤の打刻（どちらも任意）
  time_start  time,
  time_end    time,
  -- 勤務地変更のときだけ
  location    text check (location is null or char_length(location) <= 100),
  -- 理由（文例＋書き足しを文字のまま1列で持つ。文例の文言が変わっても古いメモが壊れない）
  reason      text not null default '' check (char_length(reason) <= 500),
  -- 申請済みの印（送信に成功したとき、つながっているメモに付ける）
  applied_at        timestamptz,
  applied_report_id uuid references public.overtime_reports(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- 「その他」は内容が必須
  constraint overtime_memos_other_needs_text
    check (kind <> 'other' or char_length(btrim(coalesce(kind_other, ''))) > 0),
  -- 理由は必須。打刻忘れ・打刻ズレだけは任意（「打刻忘れ」そのものが理由になるため）
  constraint overtime_memos_reason_required
    check (kind in ('missed_clock', 'clock_only') or char_length(btrim(reason)) > 0)
);

comment on table public.overtime_memos is
  '残業申請のメモ（本人だけが見る・申請の前に書いておく）。1人20件まで（トリガー）。日付から90日で毎晩消える。docs/計画-残業申請メモ.md';
comment on column public.overtime_memos.kind is
  '何があった？（目印）。missed_clock=打刻忘れ／clock_only=打刻ズレ は別のもの。day_off=調整休・振替・欠勤';

create index if not exists idx_overtime_memos_user_date
  on public.overtime_memos(user_id, target_date);

-- 🚨 cron の掃除は target_date だけで絞る
create index if not exists idx_overtime_memos_target_date
  on public.overtime_memos(target_date);

drop trigger if exists trg_overtime_memos_updated_at on public.overtime_memos;
create trigger trg_overtime_memos_updated_at
  before update on public.overtime_memos
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------
-- 上限（1人20件）と、書ける日付の範囲
-- ------------------------------------------------------------
-- 🚨 画面だけで止めると抜け道になる。RLS の with check で数える方法は、2台の端末から
--    同時に保存すると両方とも通る。→ 同じ人の保存を鍵で1本ずつにしてから数える。
-- 🚨 画面はエラーコード OTM20 を見て「メモは20件までです」と言い換える（文字で判定しない）。
-- 🚨 日付の下限（90日前）は掃除と同じ基準。これより前を許すと、保存した翌朝に消える。
--    上限は画面側（事前申請の上限 advanceMaxDate）が正。ここは打ち間違い防止の外枠だけ（1年先）。
create or replace function public.overtime_memos_guard()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_today date := (now() at time zone 'Asia/Tokyo')::date;
  v_count int;
begin
  if tg_op = 'INSERT' then
    perform pg_advisory_xact_lock(hashtext('overtime_memos:' || new.user_id::text));
    select count(*) into v_count from public.overtime_memos where user_id = new.user_id;
    if v_count >= 20 then
      raise exception 'メモは20件までです' using errcode = 'OTM20';
    end if;
  end if;

  if tg_op = 'INSERT' or new.target_date is distinct from old.target_date or new.kind is distinct from old.kind then
    if new.target_date < v_today - 90 or new.target_date > v_today + 366 then
      raise exception 'メモに書ける日付の範囲の外です' using errcode = 'OTM21';
    end if;
    -- 打刻忘れ・打刻ズレは事後報告でしか出せないので、今日以前だけ
    if new.kind in ('missed_clock', 'clock_only') and new.target_date > v_today then
      raise exception '打刻のメモは今日以前の日付だけです' using errcode = 'OTM22';
    end if;
  end if;

  return new;
end;
$$;

-- 🚨 Supabase は新しい関数に anon の実行権限を自動で付ける。from public だけでは外れない
revoke execute on function public.overtime_memos_guard() from public;
revoke execute on function public.overtime_memos_guard() from anon;

drop trigger if exists trg_overtime_memos_guard on public.overtime_memos;
create trigger trg_overtime_memos_guard
  before insert or update on public.overtime_memos
  for each row execute function public.overtime_memos_guard();

-- ------------------------------------------------------------
-- RLS：本人だけ（管理者も見ない）
-- ------------------------------------------------------------
alter table public.overtime_memos enable row level security;

drop policy if exists otmemo_select on public.overtime_memos;
create policy otmemo_select on public.overtime_memos for select to authenticated
  using (user_id = auth.uid());

drop policy if exists otmemo_insert on public.overtime_memos;
create policy otmemo_insert on public.overtime_memos for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists otmemo_update on public.overtime_memos;
create policy otmemo_update on public.overtime_memos for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists otmemo_delete on public.overtime_memos;
create policy otmemo_delete on public.overtime_memos for delete to authenticated
  using (user_id = auth.uid());

-- 🚨 Supabase は新しいテーブルに anon の権限を自動で付ける。ログイン前提の機能なので外す
revoke all on public.overtime_memos from anon;

-- ------------------------------------------------------------
-- 掃除：メモの日付から90日たったら消す（申請済みも含む）
-- ------------------------------------------------------------
select cron.unschedule('purge-overtime-memos-daily')
 where exists (select 1 from cron.job where jobname = 'purge-overtime-memos-daily');

select cron.schedule(
  'purge-overtime-memos-daily',
  '15 19 * * *',   -- UTC19:15 = JST 4:15（他の掃除とずらす）
  $$
  delete from public.overtime_memos
   where target_date < (now() at time zone 'Asia/Tokyo')::date - 90;
  $$
);
