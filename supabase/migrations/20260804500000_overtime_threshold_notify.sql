-- 残業がしきい値を超えたときのお知らせ（バナー＋ベル＋プッシュ＋メール）
--
-- これまでは App.tsx がホームを開くたびに集計してバナーを出すだけで、通知は一切なかった。
-- ここでは次を追加する。
--   ・しきい値を役職別／個人別に設定できるようにする（除外者も指定できる）
--   ・「超えたとき」「毎月の指定日」に通知を出す
--   ・判定を DB 側に置く（自己受理など overtime-approve を通らない経路が6つあるため）
--
-- 集計は client/src/pages/OvertimePage.tsx の computeBalance と同じ「見込み合計」に揃える。
-- 見込み＝確定(confirmed)＋未確定(requested/request_confirmed/reported)。
-- こうすると調整休を「申請した時点」で合計が下がり、差し戻し・取消で戻る。

-- ───────────────────────────────────────────
-- 1) 設定：通知のタイミング
-- ───────────────────────────────────────────
alter table public.overtime_settings
  add column if not exists notify_on_exceed boolean not null default true,
  add column if not exists notify_days integer[] not null default '{25,5}',
  add column if not exists notify_daily boolean not null default false;

comment on column public.overtime_settings.notify_days is
  '毎月この日に念押しする（1〜31。32＝月末日。定期リマインドと同じ規約）';

-- ───────────────────────────────────────────
-- 2) しきい値のルール（役職別・個人別・除外）
--    優先順位： 個人 > 役職 > overtime_settings.threshold_minutes（全員の既定）
-- ───────────────────────────────────────────
create table if not exists public.overtime_threshold_rules (
  id uuid primary key default gen_random_uuid(),
  role_title text,
  user_id uuid references public.profiles(id) on delete cascade,
  threshold_minutes integer,
  excluded boolean not null default false,
  created_at timestamptz not null default now(),
  -- 役職ルールか個人ルールのどちらか一方
  constraint overtime_threshold_rules_scope_check
    check ((role_title is not null and user_id is null)
        or (role_title is null and user_id is not null)),
  -- 除外でないなら時間の指定が要る
  constraint overtime_threshold_rules_value_check
    check (excluded or threshold_minutes is not null)
);

create unique index if not exists overtime_threshold_rules_role_uniq
  on public.overtime_threshold_rules (role_title) where role_title is not null;
create unique index if not exists overtime_threshold_rules_user_uniq
  on public.overtime_threshold_rules (user_id) where user_id is not null;

alter table public.overtime_threshold_rules enable row level security;

drop policy if exists otr_select on public.overtime_threshold_rules;
create policy otr_select on public.overtime_threshold_rules
  for select to authenticated using (true);

drop policy if exists otr_admin_all on public.overtime_threshold_rules;
create policy otr_admin_all on public.overtime_threshold_rules
  for all to authenticated
  using ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
  with check ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- ───────────────────────────────────────────
-- 3) 通知済みの記録（二重送信の防止＋前回との比較用）
--    notify_key: 'exceed'（超えたとき・期に1回） / 'YYYY-MM-DD'（指定日・その日1回）
--    total_minutes を持つのは、上長向けに「前回からの増加」を出すため。
--    threshold_minutes を持つのは、しきい値を下げたときに再通知できるようにするため。
-- ───────────────────────────────────────────
create table if not exists public.overtime_threshold_notifications (
  id bigserial primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  pay_period_start date not null,
  kind text not null check (kind in ('exceed', 'scheduled')),
  notify_key text not null,
  total_minutes integer not null,
  threshold_minutes integer not null,
  created_at timestamptz not null default now(),
  unique (user_id, pay_period_start, kind, notify_key)
);

create index if not exists otn_period_idx
  on public.overtime_threshold_notifications (pay_period_start, user_id, created_at desc);

-- RLS はポリシーを作らない＝クライアントから直接は触れない（service_role と SECURITY DEFINER のみ）
alter table public.overtime_threshold_notifications enable row level security;

-- ───────────────────────────────────────────
-- 4) バナーを閉じた記録
--    ✕      … 次の配信まで出さない（dismissed_at を配信時刻と比べる）
--    後で再通知 … remind_after（翌朝）まで出さない
--    ⚠️ 既存行は「その期は永久に閉じた」意味だったので、そのまま残すと復活しない。
--       残業機能は社長のみの先行公開でテスト中のため、ここでは既存行を消して仕切り直す。
-- ───────────────────────────────────────────
alter table public.overtime_banner_dismissals
  add column if not exists dismissed_at timestamptz,
  add column if not exists remind_after timestamptz;

delete from public.overtime_banner_dismissals;

-- ───────────────────────────────────────────
-- 5) 集計：見込み合計（computeBalance と同じ計算）
-- ───────────────────────────────────────────
create or replace function public.overtime_planned_totals(p_period date)
returns table (user_id uuid, planned_total integer, confirmed_total integer)
language sql stable security definer set search_path = public
as $$
  with auto_dates as (
    -- 休暇受理で自動作成されたマイナス行（確定済み）がある日
    select applicant_id, work_date
    from overtime_reports
    where pay_period_start = p_period
      and status = 'confirmed'
      and entry_type = 'leave_auto'
  ),
  counted as (
    select r.applicant_id, r.status, coalesce(r.diff_minutes, 0) as diff
    from overtime_reports r
    where r.pay_period_start = p_period
      and r.status in ('confirmed', 'requested', 'request_confirmed', 'reported')
      -- 二重減算防止：同日に確定の leave_auto があるなら、手動の時間外調整休は数えない
      and not (
        r.entry_type = 'manual'
        and 'chosei_off' = any(coalesce(r.application_types, '{}'::text[]))
        and exists (
          select 1 from auto_dates a
          where a.applicant_id = r.applicant_id and a.work_date = r.work_date
        )
      )
  )
  -- planned = 確定＋未確定（見込み。しきい値の判定はこちらを使う）
  -- confirmed = 確認済みのぶんだけ（バナーに併記する参考値）
  select applicant_id,
         sum(diff)::integer,
         sum(diff) filter (where status = 'confirmed')::integer
  from counted
  group by applicant_id;
$$;

-- ───────────────────────────────────────────
-- 6) その人のしきい値（分）。除外されているなら null
-- ───────────────────────────────────────────
create or replace function public.overtime_threshold_for(p_user uuid)
returns integer
language plpgsql stable security definer set search_path = public
as $$
declare
  v_rule   record;
  v_role   text;
  v_default integer;
begin
  -- 個人の指定が最優先
  select threshold_minutes, excluded into v_rule
  from overtime_threshold_rules where user_id = p_user;
  if found then
    if v_rule.excluded then return null; end if;
    return v_rule.threshold_minutes;
  end if;

  -- 次に役職
  select role_title into v_role from profiles where id = p_user;
  if v_role is not null then
    select threshold_minutes, excluded into v_rule
    from overtime_threshold_rules where role_title = v_role;
    if found then
      if v_rule.excluded then return null; end if;
      return v_rule.threshold_minutes;
    end if;
  end if;

  -- 最後に全員の既定
  select threshold_minutes into v_default from overtime_settings where id = 1;
  return coalesce(v_default, 600);
end;
$$;

-- ───────────────────────────────────────────
-- 7) 超過している人の一覧（在籍者のみ・パートは残業機能の対象外）
-- ───────────────────────────────────────────
create or replace function public.overtime_threshold_over(p_period date)
returns table (user_id uuid, total_minutes integer, confirmed_minutes integer, threshold_minutes integer)
language sql stable security definer set search_path = public
as $$
  select t.user_id, t.planned_total, coalesce(t.confirmed_total, 0), th.v
  from overtime_planned_totals(p_period) t
  join profiles p on p.id = t.user_id
  cross join lateral (select overtime_threshold_for(t.user_id) as v) th
  where p.is_active = true
    and coalesce(p.employment_type, '') <> 'パート'
    and th.v is not null
    and t.planned_total > th.v;
$$;

-- 🚨 この2つは全員分を返すので authenticated に開放しない（誰でも他人の残業超過が見えてしまう）。
--    クライアントは下の overtime_threshold_banner を通す。Edge Function は service_role で呼ぶ。
revoke all on function public.overtime_planned_totals(date) from authenticated;
revoke all on function public.overtime_threshold_over(date) from authenticated;
grant execute on function public.overtime_threshold_for(uuid) to authenticated;

-- ───────────────────────────────────────────
-- 7-2) ホームのバナー用。呼んだ本人に見せてよいものだけを返す
--   self    … 自分が超過しているか（超過していなければ null）
--   members … 自分より下の役職で、同じ部門の超過者。前回の配信からの増加つき
--             （社長・管理者など「絞り込みの対象外」の役職は全部門）
--   閉じた状態（✕・後で再通知）もここで判定して、出すべきものだけ返す
-- ───────────────────────────────────────────
create or replace function public.overtime_threshold_banner(p_period date)
returns jsonb
language plpgsql stable security definer set search_path = public
as $$
declare
  v_viewer     uuid := auth.uid();
  v_rank       integer;
  v_teams      text[];
  v_my_teams   text[];
  v_org_wide   boolean := false;
  v_role       text;
  v_last_sent  timestamptz;
  v_self       jsonb := null;
  v_members    jsonb := '[]'::jsonb;
  v_recipient  text;
begin
  if v_viewer is null then return jsonb_build_object('self', null, 'members', '[]'::jsonb); end if;

  select role_title into v_role from profiles where id = v_viewer;
  v_rank := overtime_role_rank(v_viewer);

  -- 部門として扱うグループ（管理画面で選んだもの）と、自分が属する部門
  select banner_group_names into v_teams from overtime_settings where id = 1;
  select array(select unnest(coalesce(group_names, '{}'::text[]))
               intersect select unnest(coalesce(v_teams, '{}'::text[])))
    into v_my_teams from profiles where id = v_viewer;

  -- 通知設定の「絞り込みの対象外にする役職」に自分の役職が入っていれば全部門を見る
  select recipient into v_recipient from notification_settings
   where event_key = 'overtime:threshold' and channel = 'site';
  if v_recipient is not null and v_role is not null then
    v_org_wide := (v_recipient::jsonb -> 'orgWideRoles') ? v_role;
  end if;

  -- 直近の配信時刻（これより後に閉じたバナーは出さない）
  select max(created_at) into v_last_sent
    from overtime_threshold_notifications where pay_period_start = p_period;

  -- 自分の分
  select jsonb_build_object(
           'total', o.total_minutes,
           'confirmed', o.confirmed_minutes,
           'threshold', o.threshold_minutes)
    into v_self
    from overtime_threshold_over(p_period) o
   where o.user_id = v_viewer
     and not exists (
       select 1 from overtime_banner_dismissals d
        where d.user_id = v_viewer and d.target_user_id = v_viewer
          and d.pay_period_start = p_period
          and (
            (d.remind_after is not null and d.remind_after > now())
            or (d.remind_after is null and v_last_sent is not null
                and d.dismissed_at is not null and d.dismissed_at >= v_last_sent)
          )
     );

  -- 部下の分（部門集計を見られる権限がある人だけ）
  if has_feature_permission('overtime_summary') or
     (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin' then
    select coalesce(jsonb_agg(
             jsonb_build_object(
               'user_id', x.user_id,
               'name', x.name,
               'team', x.team,
               'total', x.total_minutes,
               'prev', x.prev_total,
               'is_new', x.prev_total is null
             ) order by x.total_minutes desc), '[]'::jsonb)
      into v_members
      from (
        select o.user_id, p.name, o.total_minutes,
               (select array_to_string(array(
                  select unnest(coalesce(p.group_names, '{}'::text[]))
                  intersect select unnest(coalesce(v_teams, '{}'::text[]))
                ), '・')) as team,
               (select n.total_minutes from overtime_threshold_notifications n
                 where n.user_id = o.user_id and n.pay_period_start = p_period
                   and n.kind = 'scheduled'
                 order by n.created_at desc offset 1 limit 1) as prev_total
          from overtime_threshold_over(p_period) o
          join profiles p on p.id = o.user_id
         where o.user_id <> v_viewer
           and overtime_role_rank_target(o.user_id) >= v_rank
           and (v_org_wide or coalesce(p.group_names, '{}'::text[]) && coalesce(v_my_teams, '{}'::text[]))
           and not exists (
             select 1 from overtime_banner_dismissals d
              where d.user_id = v_viewer and d.target_user_id = o.user_id
                and d.pay_period_start = p_period
                and (
                  (d.remind_after is not null and d.remind_after > now())
                  or (d.remind_after is null and v_last_sent is not null
                      and d.dismissed_at is not null and d.dismissed_at >= v_last_sent)
                )
           )
      ) x;
  end if;

  return jsonb_build_object(
    'self', v_self,
    'members', v_members,
    'last_sent', v_last_sent
  );
end;
$$;

grant execute on function public.overtime_threshold_banner(date) to authenticated;

-- ───────────────────────────────────────────
-- 8) しきい値を超えた瞬間の通知（本人だけ）
--    🚨 Edge Function ではなくトリガーに置く。overtime-approve を通らない経路が
--       6つある（自己受理／管理者の差戻・削除・取消・修正／休暇受理トリガー）ため。
-- ───────────────────────────────────────────
create or replace function public.notify_overtime_threshold_exceeded()
returns trigger
language plpgsql security definer set search_path = public
as $$
declare
  v_user     uuid;
  v_period   date;
  v_total    integer;
  v_threshold integer;
  v_on       boolean;
  v_name     text;
begin
  v_user   := coalesce(new.applicant_id, old.applicant_id);
  v_period := coalesce(new.pay_period_start, old.pay_period_start);
  if v_user is null or v_period is null then return coalesce(new, old); end if;

  select notify_on_exceed into v_on from overtime_settings where id = 1;
  if not coalesce(v_on, true) then return coalesce(new, old); end if;

  v_threshold := overtime_threshold_for(v_user);
  if v_threshold is null then return coalesce(new, old); end if;  -- 除外されている人

  select planned_total into v_total from overtime_planned_totals(v_period) where user_id = v_user;
  if coalesce(v_total, 0) <= v_threshold then return coalesce(new, old); end if;

  -- 期に1回だけ。しきい値が下がった場合は前回より低い値なので再通知したいが、
  -- ここでは単純に「その期に1回」とする（指定日の通知が拾うため）
  insert into overtime_threshold_notifications
    (user_id, pay_period_start, kind, notify_key, total_minutes, threshold_minutes)
  values (v_user, v_period, 'exceed', 'exceed', v_total, v_threshold)
  on conflict (user_id, pay_period_start, kind, notify_key) do nothing;

  if not found then return coalesce(new, old); end if;

  select name into v_name from profiles where id = v_user;

  -- ベル通知。event_key を入れると push_queue に積まれ push-dispatch が拾う。
  -- ⚠️ 本文に「リマインド」「お知らせ」「メッセージが届き」を入れないこと
  --    （App.tsx の連絡板判定が先に効いてタップで /board に飛ぶ）
  insert into notifications (user_id, message, sub_message, source_type, event_key, reference_id)
  values (
    v_user,
    '今月の残業が' || (v_threshold / 60)::text || '時間を超えました',
    '時間調整をお願いします',
    'overtime:threshold',
    'overtime:threshold',
    v_period::text
  );

  return coalesce(new, old);
exception when others then
  -- 通知に失敗しても残業の登録そのものは通す
  return coalesce(new, old);
end;
$$;

drop trigger if exists trg_notify_overtime_threshold on public.overtime_reports;
create trigger trg_notify_overtime_threshold
  after insert or update or delete on public.overtime_reports
  for each row execute function public.notify_overtime_threshold_exceeded();

-- ───────────────────────────────────────────
-- 9) 通知設定（管理画面に出す。行が無いと画面に欄自体が出ない）
--    宛先は「本人＋リーダー以上」。グループ絞り込みは同グループのみ、
--    社長・管理者だけ絞り込みの対象外（全部門が見える）＝本日実装した仕組みに合わせる
-- ───────────────────────────────────────────
insert into public.notification_settings (event_key, channel, enabled, recipient, subject, template)
values
  ('overtime:threshold', 'site',  true,
   '{"roles":["申請者本人","リーダー","マネージャー","社長","管理者"],"groupFilter":"same","orgWideRoles":["社長","管理者"]}',
   null, null),
  ('overtime:threshold', 'push',  true,
   '{"roles":["申請者本人","リーダー","マネージャー","社長","管理者"],"groupFilter":"same","orgWideRoles":["社長","管理者"]}',
   null, null),
  ('overtime:threshold', 'email', false,
   '{"roles":["申請者本人","リーダー","マネージャー","社長","管理者"],"groupFilter":"same","orgWideRoles":["社長","管理者"]}',
   E'残業時間のお知らせ',
   E'{{対象者名}}さんの今月（{{期間}}）の残業は {{残業時間}} です。\n\n時間調整をお願いします。調整が難しい場合はリーダー・マネージャーへご相談ください。\n\n{{リンク}}')
on conflict (event_key, channel) do nothing;
