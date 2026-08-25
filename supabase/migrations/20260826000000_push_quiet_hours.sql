-- ============================================================
-- プッシュ通知の受信時間帯設定（本人設定）
--
-- 仕組み:
--   本人が push_preferences に「受信する時間帯」「休暇日は受け取らない」を設定
--   → 配達側（push-dispatch / send-push）が push_muted_user_ids() で判定し、
--     時間外・休暇日のプッシュは保留 → 受信時間になったらまとめて届く
--   例外（時間外でも鳴る）:
--     ① 安否確認（safety:*）＝push-dispatch の EVENT_MAP 側で urgent 扱い
--     ② 連絡板の「当日の連絡・緊急」チェック付き投稿
--        （notifications.push_urgent → push_queue.urgent で運ぶ）
--
-- 🚨 方針: プッシュは fail-open（判定に失敗したら「送る」）。
--    「送られ過ぎは気づけるが、送られないのは誰も気づけない」ため。
--
-- ロールバック手順（🚨 必ずこの順番。逆にすると enqueue トリガーが
-- 存在しない列 push_urgent を参照して EXCEPTION 捕捉に握りつぶされ、
-- エラーゼロで全プッシュのキュー投入が静かに止まる）:
--   ① enqueue_push_notification を 20260720000000 の旧定義に戻す
--   ② alter table notifications drop column push_urgent;
--      alter table push_queue drop column urgent;
--   ③ drop function push_muted_user_ids(uuid[]);
--      drop table push_deferred; drop table push_preferences;
-- ============================================================

-- 1) 本人のプッシュ受信設定
create table if not exists push_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  quiet_enabled boolean not null default false,   -- 「通知を受け取る時間を決める」
  receive_start time,                             -- 受信開始（例 07:00）。受信帯は [start, end)
  receive_end   time,                             -- 受信終了（例 22:00）。start > end は日またぎ受信
  mute_on_leave boolean not null default false,   -- 「休暇日は通知を受け取らない」
  updated_at timestamptz not null default now()
);

alter table push_preferences enable row level security;

-- 本人のみ読み書き（受信時間帯＝生活パターンなので他人には見せない）。
-- 配達側は service_role なので RLS の影響を受けない
drop policy if exists push_prefs_select_own on push_preferences;
create policy push_prefs_select_own on push_preferences
  for select to authenticated using (user_id = auth.uid());
drop policy if exists push_prefs_insert_own on push_preferences;
create policy push_prefs_insert_own on push_preferences
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists push_prefs_update_own on push_preferences;
create policy push_prefs_update_own on push_preferences
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 2) 直送プッシュの保留置き場（キューを通らない send-push 直接呼び出し分の退避先）
--    RLSポリシーを作らない＝クライアント遮断・service_roleのみ（push_queueと同じ方針）
create table if not exists push_deferred (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  payload jsonb not null,   -- send-push に渡す {title, body, url, tag} をそのまま保存
  status text not null default 'pending' check (status in ('pending','sent','failed')),
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists idx_push_deferred_pending on push_deferred (status, created_at) where status = 'pending';
alter table push_deferred enable row level security;

-- 3) 緊急フラグを運ぶ列
alter table notifications add column if not exists push_urgent boolean not null default false;
alter table push_queue    add column if not exists urgent      boolean not null default false;

-- 4) enqueue トリガー更新: push_urgent を push_queue.urgent へコピー。
--    dedupe（同一user×event×refのpendingあり）で積まない場合でも、
--    新規が緊急なら既存行を緊急に格上げする（緊急フラグの握りつぶし防止）
create or replace function enqueue_push_notification()
returns trigger
security definer
set search_path = public
language plpgsql as $$
begin
  begin
    if NEW.event_key is not null
       and exists (select 1 from push_subscriptions s where s.user_id = NEW.user_id)
    then
      if not exists (
        select 1 from push_queue q
        where q.user_id = NEW.user_id
          and q.event_key = NEW.event_key
          and q.status = 'pending'
          and coalesce(q.reference_id, '') = coalesce(NEW.reference_id, '')
      ) then
        insert into push_queue (user_id, event_key, reference_id, urgent)
        values (NEW.user_id, NEW.event_key, NEW.reference_id, coalesce(NEW.push_urgent, false));
      elsif coalesce(NEW.push_urgent, false) then
        update push_queue set urgent = true
        where user_id = NEW.user_id
          and event_key = NEW.event_key
          and status = 'pending'
          and coalesce(reference_id, '') = coalesce(NEW.reference_id, '')
          and not urgent;
      end if;
    end if;
  exception when others then
    -- キュー投入の失敗でベル通知本体のINSERTを巻き込まない
    null;
  end;
  return NEW;
end $$;

-- 5) ミュート判定関数（push-dispatch / send-push の両方がこれを呼ぶ＝判定の一元化。
--    Deno の Edge Function 間ではコードを共有できないため、DB側に1本化する）
--
--    渡したユーザーIDのうち「今ミュート中（保留すべき）」の人だけ返す。
--    設定行が無い人・quiet_enabled/mute_on_leave が false の人は返さない（既定＝制限なし）。
--    受信時間帯は [receive_start, receive_end)。start > end は日またぎ受信（例 22:00〜翌7:00 受信）。
--
--    🚨 fail-open: 不正データ等で判定に失敗したら空配列（＝ミュートなし＝送る）を返す。
--       1行の壊れた leave_dates で全プッシュが止まる事故を防ぐ。
--    🚨 overtime の leave_auto 行は application_types が入らない（既知）が、
--       その発生元は必ず受理済み leave_requests なので ① の休暇判定でカバーされる。
--       ①の条件を変えるときはこの前提を壊さないこと。
create or replace function push_muted_user_ids(p_user_ids uuid[])
returns uuid[]
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  v_now_jst timestamp := (now() at time zone 'Asia/Tokyo');
  v_time time := v_now_jst::time;
  v_today date := v_now_jst::date;
  v_today_str text := to_char(v_now_jst, 'YYYY-MM-DD');
  v_muted uuid[];
begin
  select coalesce(array_agg(p.user_id), '{}'::uuid[]) into v_muted
  from push_preferences p
  where p.user_id = any(p_user_ids)
    and (
      -- (a) 受信時間帯の外
      (p.quiet_enabled
        and p.receive_start is not null
        and p.receive_end is not null
        and p.receive_start <> p.receive_end
        and case
          when p.receive_start < p.receive_end
            then not (v_time >= p.receive_start and v_time < p.receive_end)
          else     (v_time >= p.receive_end   and v_time < p.receive_start)
        end)
      or
      -- (b) 休暇日（本人の受理済み休暇・終日の休み・会社の全社休み）
      (p.mute_on_leave and (
        exists (select 1 from company_calendar cc
                where cc.date = v_today and cc.kind = 'closed_all')
        or exists (
          select 1 from leave_requests lr
          where lr.user_id = p.user_id
            and lr.status = 'approved'
            and (
              -- leave_dates は JSON 配列の文字列。先頭が '[' の行だけキャストする
              -- （不正データでのキャスト失敗を減らす。失敗しても関数全体の EXCEPTION で fail-open）
              (lr.leave_dates is not null
                and lr.leave_dates ~ '^\s*\['
                and lr.leave_dates::jsonb ? v_today_str)
              or (lr.leave_dates is null
                and lr.start_date is not null and lr.end_date is not null
                and lr.start_date <= v_today and lr.end_date >= v_today)
            )
        )
        or exists (
          select 1 from overtime_reports ot
          where ot.applicant_id = p.user_id
            and ot.work_date = v_today
            and ot.status in ('request_confirmed','reported','confirmed')
            and ot.application_types && array['chosei_off','furikae_off','absence']
        )
      ))
    );
  return v_muted;
exception when others then
  -- fail-open: 判定に失敗したら「誰もミュートしない」＝送る
  return '{}'::uuid[];
end $$;

-- 🚨 SECURITY DEFINER 関数は作成時に public/anon/authenticated へ自動で EXECUTE が付く。
--    この関数は「同僚が今日休みか」を推測できる（病欠＝要配慮情報に連なる）ため、
--    service_role（配達ワーカー）以外から呼べないようにする
revoke execute on function push_muted_user_ids(uuid[]) from public;
revoke execute on function push_muted_user_ids(uuid[]) from anon;
revoke execute on function push_muted_user_ids(uuid[]) from authenticated;
grant  execute on function push_muted_user_ids(uuid[]) to service_role;
