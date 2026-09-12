-- シフト調整の作業場：土台（表・許可・権限・掃除）
-- 設計は docs/計画-シフト調整.md（2026-09-12 ユーザー確定）。これは「作る順番」の **手順2**。
--
-- 【このファイルでやること】
--   ・表を6つ作る ・RLS（誰が読み書きしてよいか）・機能権限を5つ足す ・古い相談の掃除の cron
-- 【このファイルでやらないこと（あとの手順）】
--   ・自動で場を作る仕組み（トリガー）＝手順4
--   ・`set_leave_shift_adjust` の差し替え＝手順3
--   ・決定の RPC・お知らせの設定＝画面と一緒
--   🚨 手順3が入るまで、**この表には1行も入らない**（トリガーがまだ無いため）。
--      ＝ここを適用しても、いまの運用は1ミリも変わらない。
--
-- 【🚨 休んだ本人には見せない】
--   調整の中身は「誰が代わりに入るか」の相談で、休んだ本人が読むものではない（ユーザー確定）。
--   そこで**すべての表の読み取りに「休んだ本人でない」を掛ける**。
--   🚨 子の表にも**親を見に行く形で**掛ける（親だけに掛けると、子を直接読まれたときに素通りする）。
--
-- 【🚨 書き込みは原則ぜんぶ関数（SECURITY DEFINER）から】
--   場を作る・決める・依頼を送るは、確かめることが多く、途中で失敗したら全部取り消す必要がある。
--   そのため**直接の書き込みの許可は作らない**（許可が無ければ書けない）。
--   例外は「コメント」「案」「確認した」の3つだけ。これは本人が自分の名前で1行足すだけなので許可で足りる。

-- ───────────────────────────────────────────────────────────────
-- 1. 見出しの行（日ごと・人ごとに1つ）
-- ───────────────────────────────────────────────────────────────
create table if not exists public.shift_adjust_slots (
  id                            uuid primary key default gen_random_uuid(),
  target_user_id                uuid not null references public.profiles(id) on delete cascade,
  target_date                   date not null,
  -- 何がきっかけか。🚨 遅刻・早退へ広げるときは、ここに値を足すだけで鍵は変えない
  cause                         text not null check (cause in ('leave', 'absent')),
  cause_leave_request_id        uuid references public.leave_requests(id) on delete set null,
  cause_attendance_exception_id uuid references public.attendance_exceptions(id) on delete set null,
  status                        text not null default 'pending'
                                  check (status in ('pending', 'working', 'decided', 'no_change',
                                                    'closed_past', 'cause_cancelled')),
  decided_by                    uuid references public.profiles(id) on delete set null,
  decided_at                    timestamptz,
  -- みんなのカレンダーへ反映できたか（DBからは呼べないので画面が押し直せるように印だけ持つ）
  gcal_synced_at                timestamptz,
  -- 相談の記録を掃除した日。🚨 見出しの行は消さない（消すと未調整に戻り、お知らせが再び飛ぶ）
  purged_at                     timestamptz,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  -- 🚨 鍵に cause を入れない。同じ人の同じ日に休暇と欠勤が重なる例が本番に2件あり、
  --    入れると場が2つできて相談が分かれる
  constraint shift_adjust_slots_user_date_key unique (target_user_id, target_date)
);

comment on table public.shift_adjust_slots is
  'シフト調整の作業場の見出し（人×日で1つ）。中身の相談は子の表。🚨 休んだ本人には見せない';
comment on column public.shift_adjust_slots.purged_at is
  '相談の記録を90日で掃除した日。🚨 この行自体は消さない（消すと未調整に戻りお知らせが再び飛ぶ）';

create index if not exists idx_shift_adjust_slots_status_date
  on public.shift_adjust_slots (status, target_date);
create index if not exists idx_shift_adjust_slots_date
  on public.shift_adjust_slots (target_date);

-- ───────────────────────────────────────────────────────────────
-- 2. 決定で「誰がどの時間帯に入るか」
-- ───────────────────────────────────────────────────────────────
create table if not exists public.shift_adjust_assignments (
  id                      uuid primary key default gen_random_uuid(),
  slot_id                 uuid not null references public.shift_adjust_slots(id) on delete cascade,
  user_id                 uuid not null references public.profiles(id) on delete cascade,
  -- 「午前は◯◯さん・午後は△△さん」を表すための時間帯。勤怠の work_segments と同じ形
  segments                jsonb not null default '[]'::jsonb,
  -- パートは勤怠の登録／正社員は残業申請の依頼
  kind                    text not null check (kind in ('attendance', 'overtime_request')),
  attendance_exception_id uuid references public.attendance_exceptions(id) on delete set null,
  application_request_id  uuid references public.application_requests(id) on delete set null,
  created_at              timestamptz not null default now(),
  constraint shift_adjust_assignments_slot_user_key unique (slot_id, user_id)
);

comment on table public.shift_adjust_assignments is
  '決定した「代わりに入る人」と時間帯。作るのは決定のRPCだけ（直接の書き込みの許可は無い）';

create index if not exists idx_shift_adjust_assignments_slot
  on public.shift_adjust_assignments (slot_id);

-- ───────────────────────────────────────────────────────────────
-- 3. 相談（コメント）
-- ───────────────────────────────────────────────────────────────
create table if not exists public.shift_adjust_comments (
  id         uuid primary key default gen_random_uuid(),
  slot_id    uuid not null references public.shift_adjust_slots(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  body       text not null check (btrim(body) <> ''),
  created_at timestamptz not null default now()
);

create index if not exists idx_shift_adjust_comments_slot
  on public.shift_adjust_comments (slot_id, created_at);

-- ───────────────────────────────────────────────────────────────
-- 4. 案 と 確認（「確認した」ボタン）
-- ───────────────────────────────────────────────────────────────
create table if not exists public.shift_adjust_plans (
  id            uuid primary key default gen_random_uuid(),
  slot_id       uuid not null references public.shift_adjust_slots(id) on delete cascade,
  created_by    uuid not null references public.profiles(id) on delete cascade,
  body          text not null check (btrim(body) <> ''),
  -- 意見の期限（任意）
  review_due_at timestamptz,
  created_at    timestamptz not null default now()
);

create index if not exists idx_shift_adjust_plans_slot
  on public.shift_adjust_plans (slot_id, created_at);

create table if not exists public.shift_adjust_plan_reviews (
  id         uuid primary key default gen_random_uuid(),
  plan_id    uuid not null references public.shift_adjust_plans(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint shift_adjust_plan_reviews_plan_user_key unique (plan_id, user_id)
);

-- ───────────────────────────────────────────────────────────────
-- 5. パートへの「出勤のお願い」
-- ───────────────────────────────────────────────────────────────
-- 🚨 呼び名は「出勤のお願い」（既存の「申請の依頼」= application_requests と紛れないように・ユーザー確定）
-- 🚨🚨 **休んだ人の名前・休暇の種類はこの表に持たない。**
--      パートはこの行だけを読む（親の見出しは読めない）ので、ここに載せたものがそのまま相手に見える。
--      そのため、相手に見せてよい「日付・時間帯・校」だけをこの行が自分で持つ。
--      （設計書の項目一覧には日付・時間帯・校を書いていなかったが、親を読めない以上ここに要る）
create table if not exists public.shift_adjust_part_requests (
  id          uuid primary key default gen_random_uuid(),
  slot_id     uuid not null references public.shift_adjust_slots(id) on delete cascade,
  plan_id     uuid references public.shift_adjust_plans(id) on delete set null,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  -- ここから下の3つが「相手に見せる中身」
  target_date date not null,
  segments    jsonb not null default '[]'::jsonb,
  location    text,
  sent_at     timestamptz not null default now(),
  due_at      timestamptz,
  answer      text check (answer in ('yes', 'no')),
  answered_at timestamptz,
  picked      boolean not null default false,
  constraint shift_adjust_part_requests_slot_user_key unique (slot_id, user_id)
);

comment on table public.shift_adjust_part_requests is
  'パートへの「出勤のお願い」。🚨 休んだ人の名前・休暇の種類は持たない（相手にそのまま見えるため）';

create index if not exists idx_shift_adjust_part_requests_user
  on public.shift_adjust_part_requests (user_id, answered_at);
create index if not exists idx_shift_adjust_part_requests_slot
  on public.shift_adjust_part_requests (slot_id);

-- ───────────────────────────────────────────────────────────────
-- 6. 機能権限を5つ足す（テスト中は社長・管理者だけ ON）
-- ───────────────────────────────────────────────────────────────
-- 🚨 役職を**名前で書かない**。改名で壊れる（2026-09-09 に「社長」の改名で本番の権限が壊れた）。
--    属性（acts_as）で指定する：president＝社長／accounting＝管理者
-- 🚨 既存の `leave_shift_adjust`（今のシフト調整の記録）とは**別物**。流用しない（ユーザー確定）
insert into public.feature_permissions (role_id, feature_key, enabled)
select r.id, k.feature_key, coalesce(r.acts_as in ('president', 'accounting'), false)
  from public.roles r
 cross join (values
   ('shift_adjust_view'),     -- ① 見る・コメント
   ('shift_adjust_review'),   -- ② 案の確認（「確認した」ボタン）
   ('shift_adjust_plan'),     -- ③ 案を作る・意見の期限を付ける
   ('shift_adjust_request'),  -- ④ パートへの依頼（出勤のお願い）
   ('shift_adjust_decide')    -- ⑤ 決定・決定の取り消し・確認済（変更なし）で閉じる
 ) as k(feature_key)
on conflict do nothing;

-- ───────────────────────────────────────────────────────────────
-- 7. 誰が読み書きしてよいか（RLS）
-- ───────────────────────────────────────────────────────────────
alter table public.shift_adjust_slots          enable row level security;
alter table public.shift_adjust_assignments    enable row level security;
alter table public.shift_adjust_comments       enable row level security;
alter table public.shift_adjust_plans          enable row level security;
alter table public.shift_adjust_plan_reviews   enable row level security;
alter table public.shift_adjust_part_requests  enable row level security;

-- 🚨 `(select has_feature_permission(...))` と括ると、行ごとではなく**1回だけ**評価される
--    （行数が増えても重くならない）

-- ① 見出し：見る権限があり、かつ**自分が休んだ本人でない**
drop policy if exists shift_adjust_slots_select on public.shift_adjust_slots;
create policy shift_adjust_slots_select on public.shift_adjust_slots
  for select using (
    (select public.has_feature_permission('shift_adjust_view'))
    and target_user_id <> auth.uid()
  );
-- 🚨 書き込みの許可は**作らない**（作る・決めるは SECURITY DEFINER の関数から。手順4以降）

-- ② 決定した割り当て：見出しが見える人だけ
drop policy if exists shift_adjust_assignments_select on public.shift_adjust_assignments;
create policy shift_adjust_assignments_select on public.shift_adjust_assignments
  for select using (
    exists (
      select 1 from public.shift_adjust_slots s
       where s.id = shift_adjust_assignments.slot_id
         and (select public.has_feature_permission('shift_adjust_view'))
         and s.target_user_id <> auth.uid()
    )
  );

-- ③ コメント：見える人が読める／自分の名前で書ける
drop policy if exists shift_adjust_comments_select on public.shift_adjust_comments;
create policy shift_adjust_comments_select on public.shift_adjust_comments
  for select using (
    exists (
      select 1 from public.shift_adjust_slots s
       where s.id = shift_adjust_comments.slot_id
         and (select public.has_feature_permission('shift_adjust_view'))
         and s.target_user_id <> auth.uid()
    )
  );
drop policy if exists shift_adjust_comments_insert on public.shift_adjust_comments;
create policy shift_adjust_comments_insert on public.shift_adjust_comments
  for insert with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.shift_adjust_slots s
       where s.id = shift_adjust_comments.slot_id
         and (select public.has_feature_permission('shift_adjust_view'))
         and s.target_user_id <> auth.uid()
    )
  );

-- ④ 案：見える人が読める／③の権限を持つ人が自分の名前で作れる
drop policy if exists shift_adjust_plans_select on public.shift_adjust_plans;
create policy shift_adjust_plans_select on public.shift_adjust_plans
  for select using (
    exists (
      select 1 from public.shift_adjust_slots s
       where s.id = shift_adjust_plans.slot_id
         and (select public.has_feature_permission('shift_adjust_view'))
         and s.target_user_id <> auth.uid()
    )
  );
drop policy if exists shift_adjust_plans_insert on public.shift_adjust_plans;
create policy shift_adjust_plans_insert on public.shift_adjust_plans
  for insert with check (
    created_by = auth.uid()
    and (select public.has_feature_permission('shift_adjust_plan'))
    and exists (
      select 1 from public.shift_adjust_slots s
       where s.id = shift_adjust_plans.slot_id
         and s.target_user_id <> auth.uid()
    )
  );

-- ⑤ 確認した：見える人が読める／②の権限を持つ人が自分の名前で押せる
drop policy if exists shift_adjust_plan_reviews_select on public.shift_adjust_plan_reviews;
create policy shift_adjust_plan_reviews_select on public.shift_adjust_plan_reviews
  for select using (
    exists (
      select 1
        from public.shift_adjust_plans p
        join public.shift_adjust_slots s on s.id = p.slot_id
       where p.id = shift_adjust_plan_reviews.plan_id
         and (select public.has_feature_permission('shift_adjust_view'))
         and s.target_user_id <> auth.uid()
    )
  );
drop policy if exists shift_adjust_plan_reviews_insert on public.shift_adjust_plan_reviews;
create policy shift_adjust_plan_reviews_insert on public.shift_adjust_plan_reviews
  for insert with check (
    user_id = auth.uid()
    and (select public.has_feature_permission('shift_adjust_review'))
    and exists (
      select 1
        from public.shift_adjust_plans p
        join public.shift_adjust_slots s on s.id = p.slot_id
       where p.id = shift_adjust_plan_reviews.plan_id
         and s.target_user_id <> auth.uid()
    )
  );

-- ⑥ 出勤のお願い：**頼まれた本人**か、見出しが見える人
--    🚨 パートは①の権限を持たないので、`user_id = auth.uid()` の側が唯一の入口になる
drop policy if exists shift_adjust_part_requests_select on public.shift_adjust_part_requests;
create policy shift_adjust_part_requests_select on public.shift_adjust_part_requests
  for select using (
    user_id = auth.uid()
    or exists (
      select 1 from public.shift_adjust_slots s
       where s.id = shift_adjust_part_requests.slot_id
         and (select public.has_feature_permission('shift_adjust_view'))
         and s.target_user_id <> auth.uid()
    )
  );
-- 🚨 送るのも答えるのも関数から（直接の書き込みの許可は作らない）。
--    答えを許可で許すと、`picked`（選ばれたか）まで本人に書き換えられてしまう

-- ───────────────────────────────────────────────────────────────
-- 8. 相談の記録の掃除（毎晩）
-- ───────────────────────────────────────────────────────────────
-- 🚨 CLAUDE.md の決まり：**記録を貯める表を作るときは、掃除も同時に作る**。
--    終わった場の相談（コメント・案・確認・依頼と返事）を90日で消す。
-- 🚨 **見出しの行（slots）は消さない**。消すと「未調整」に戻り、既存のお知らせが再び飛ぶ。
--    代わりに purged_at を立て、画面に「記録は消えました」と出す。
-- 時刻は他の掃除に合わせて深夜（18:55 UTC ＝ 日本時間 3:55）。既存の掃除は 18:00/18:30/18:40/18:45/18:50
select cron.schedule('purge-shift-adjust-daily', '55 18 * * *', $cron$
do $$
declare
  v_ids uuid[];
begin
  select array_agg(id) into v_ids
    from public.shift_adjust_slots
   where status in ('decided', 'no_change', 'closed_past', 'cause_cancelled')
     and purged_at is null
     and coalesce(decided_at, updated_at) < now() - interval '90 days';

  if v_ids is null then return; end if;

  delete from public.shift_adjust_plan_reviews
   where plan_id in (select id from public.shift_adjust_plans where slot_id = any(v_ids));
  delete from public.shift_adjust_plans         where slot_id = any(v_ids);
  delete from public.shift_adjust_comments      where slot_id = any(v_ids);
  delete from public.shift_adjust_part_requests where slot_id = any(v_ids);

  update public.shift_adjust_slots set purged_at = now() where id = any(v_ids);
end;
$$;
$cron$);
