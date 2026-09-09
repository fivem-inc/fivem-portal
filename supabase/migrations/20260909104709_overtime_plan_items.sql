-- ============================================================
-- 2026-09-09  残業の調整案（自分用）
-- ============================================================
-- きっかけ：残業が +10時間あるとき、「どこで調整できるか」を申請する前に自分で組んで
-- 見込みを確かめたい（ユーザー要望）。申請してしまうと受理のやり直しが要るため、
-- 申請の手前に「下書きの置き場」を作る。
--
-- 🚨 本人だけが見る（2026-09-09 ユーザー確定）。上長には見せない。
--    見せる前提にすると「口頭で聞いた調整予定」との食い違いが起き、
--    まだ決めていないものを催促されることになる。

create table if not exists overtime_plan_items (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  -- どの給与期間（16日〜翌15日）の調整か
  pay_period_start date not null,
  work_date    date not null,
  -- 何をする案か。申請の種別と同じ言葉を使う（画面で読み替えなくて済むように）
  kind         text not null check (kind in ('late_start_adj', 'early_end_adj', 'chosei_off', 'overtime')),
  -- 遅出・早退のときの時刻。調整休は使わない
  adjust_time  time,
  -- 残業のときの時間帯
  start_time   time,
  end_time     time,
  -- 見込みの差分（分）。画面が lib の計算で出した値をそのまま持つ
  -- 🚨 ここは「そのとき計算した結果」の控えで、正は lib の計算。
  --    シフトが変わると実際の差分は変わるので、開いたときに計算し直す
  diff_minutes int not null default 0,
  note         text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

comment on table overtime_plan_items is
  '残業の調整案（本人だけが見る下書き）。申請するとここから消える。締めを過ぎたぶんは毎晩の掃除で消える';
comment on column overtime_plan_items.diff_minutes is
  '組んだ時点の見込みの差分（分）。正は lib/overtimeShift の計算で、画面は開くたびに計算し直す';

-- 🚨 同じ日に2つ作らせない。申請側は uq_overtime_manual_per_day（本人×日付で1件）なので、
--    調整案で同じ日を2つ作ると、2つ目を申請したときに 23505 で必ず落ちる。
create unique index if not exists uq_overtime_plan_per_day
  on overtime_plan_items(user_id, work_date);

create index if not exists idx_overtime_plan_period
  on overtime_plan_items(user_id, pay_period_start);

-- ------------------------------------------------------------
-- RLS：本人だけ
-- ------------------------------------------------------------
-- 🚨 管理者の select も入れない。「本人だけが見る」と決めたので、
--    見られる人を増やすと約束が変わる（保守が必要なときは service_role で見る）。
alter table overtime_plan_items enable row level security;

drop policy if exists otplan_select on overtime_plan_items;
create policy otplan_select on overtime_plan_items for select to authenticated
  using (user_id = auth.uid());

drop policy if exists otplan_insert on overtime_plan_items;
create policy otplan_insert on overtime_plan_items for insert to authenticated
  with check (user_id = auth.uid());

drop policy if exists otplan_update on overtime_plan_items;
create policy otplan_update on overtime_plan_items for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists otplan_delete on overtime_plan_items;
create policy otplan_delete on overtime_plan_items for delete to authenticated
  using (user_id = auth.uid());

-- ------------------------------------------------------------
-- 掃除（貯める仕組みには掃除をセットで作る）
-- ------------------------------------------------------------
-- 🚨 締め（支給月17日）を過ぎた期の調整案は、もう使い道が無いので消す。
--    半年も残す必要はない（2026-09-09 ユーザー確定）。申請したものは残業の履歴に残る。
--    pay_period_start は必ず16日なので、締め切りは「その翌月17日」。
select cron.unschedule('purge-overtime-plan-items-daily')
 where exists (select 1 from cron.job where jobname = 'purge-overtime-plan-items-daily');

select cron.schedule(
  'purge-overtime-plan-items-daily',
  '45 18 * * *',   -- UTC18:45 = JST 3:45（他の掃除とずらす）
  $$
  delete from overtime_plan_items
   where (pay_period_start + interval '1 month' + interval '1 day')::date
         < (now() at time zone 'Asia/Tokyo')::date;
  $$
);
