-- ============================================================
-- FAQ（よくある質問）の土台
-- 社内向け（スタッフ＝社内サイトの使い方）と社外向け（お客様＝教室のルール）を
-- 同じ仕組みで扱う。まず社内向けを社長・管理者だけに公開して試運転する。
-- ============================================================
--
-- 【設計の芯】
-- ・AIに文章を作らせない。管理者が事前に確認した「回答の原文」だけを表示する。
--   （海外でAIチャットボットが存在しない制度を案内し、会社側が敗訴した事例があるため）
-- ・同じ質問でも、校・コース（社外向け）や役職（社内向け）で答えが変わる。
--   共通の回答を1つ持ち、違うところだけ「対象を指定した回答」で上書きする。
--   → 11コースで同じ文章を11回コピーしない＝片方だけ直して食い違う事故を防ぐ
--   （このプロジェクトが何度も踏んでいる「同じ意味の定義を2か所に書く」型の事故）
-- ・回答は「いつから・いつまで」を持つ。料金改定などを予約でき、当日の作業が要らない。
--   古い回答も残るので「その時点で何を案内していたか」を後から確認できる（係争時の防御）。

-- ============================================================
-- 1) Q&A編集専用アカウントの印
-- ============================================================
-- 役職名（role_title）で判定すると、役職の改名で権限が静かに壊れる（過去に複数回発生）。
-- 既存の profiles.leave_request_enabled と同じく、専用のフラグを1つ持つ。
alter table public.profiles
  add column if not exists is_faq_editor boolean not null default false;

comment on column public.profiles.is_faq_editor is
  'FAQ管理画面だけを使える専用アカウントの印。社内で共有ログインして使う想定';

-- RLSから呼ぶ判定関数。
-- 🚨 関数名を列名（is_faq_editor）と同じにすると、関数本体の中で列と関数のどちらを
--    指すのか曖昧になるため can_edit_faq という別名にしている。
-- 🚨 管理者判定は必ず app_metadata 経由（(auth.jwt() ->> 'role') は常に 'authenticated' で永久にfalse）
create or replace function public.can_edit_faq()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false)
      or exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and p.is_faq_editor = true
      );
$$;

-- ============================================================
-- 2) 質問
-- ============================================================
create table if not exists public.faq_topics (
  id              uuid primary key default gen_random_uuid(),
  -- internal = スタッフ向け（社内サイトの使い方） / public = お客様向け（教室のルール）
  audience        text not null check (audience in ('internal', 'public')),
  category        text not null,                       -- 休暇申請 / 体験レッスン など
  question        text not null,                       -- 質問文（利用者が聞きそうな言い方）
  keywords        text[] not null default '{}',        -- 検索用の言い換え語
  is_published    boolean not null default false,      -- 出す/出さない（人の意思）
  is_featured     boolean not null default false,      -- 「よくあるご質問」ボタンに出す
  -- 「★要確認」の印。回答本文に書くと他の文章に紛れて放置されるため独立した状態として持つ
  needs_review    boolean not null default false,
  review_note     text,
  sort_order      integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by      uuid references auth.users(id) on delete set null,
  -- 共有アカウントで編集するため、システム上の利用者だけでは「誰が」が分からない。
  -- 保存時に本人が名前を選んで残す欄
  updated_by_name text
);

create index if not exists idx_faq_topics_keywords on public.faq_topics using gin (keywords);
create index if not exists idx_faq_topics_audience on public.faq_topics (audience, is_published);

create trigger trg_faq_topics_updated_at
  before update on public.faq_topics
  for each row execute function set_updated_at();

-- ============================================================
-- 3) 回答（1つの質問に複数持てる。対象と期間を持つ）
-- ============================================================
-- valid_from が null ＝「いつから出すか未定」＝まだ出さない下書き。
-- これにより「有効な回答が1つも無い質問は検索に出ない」が自然に成立し、
-- 質問ごと隠すための別フラグを手で切り替える必要がなくなる。
create table if not exists public.faq_answers (
  id              uuid primary key default gen_random_uuid(),
  topic_id        uuid not null references public.faq_topics(id) on delete cascade,
  body            text not null,
  source_label    text,                                -- 出典の名前（入会のしおり 等）
  source_url      text,
  valid_from      date,                                -- この日から出す（nullは下書き）
  valid_until     date,                                -- この日まで出す（nullは無期限）
  -- 季節もの・第三者の制度など「放っておくと古くなる」回答の印
  needs_refresh   boolean not null default false,
  refresh_note    text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  updated_by      uuid references auth.users(id) on delete set null,
  updated_by_name text,
  constraint faq_answers_valid_range
    check (valid_until is null or valid_from is null or valid_until >= valid_from)
);

create index if not exists idx_faq_answers_topic on public.faq_answers (topic_id);

create trigger trg_faq_answers_updated_at
  before update on public.faq_answers
  for each row execute function set_updated_at();

-- ============================================================
-- 4) 回答の対象（この行が無い回答＝共通の回答）
-- ============================================================
-- 社外向けは school / course、社内向けは role_title を使う。
-- 「対象の指定が無い＝全員向け」という表現にすることで、共通回答に専用の列やフラグが要らない。
create table if not exists public.faq_answer_targets (
  id         uuid primary key default gen_random_uuid(),
  answer_id  uuid not null references public.faq_answers(id) on delete cascade,
  school     text,
  course     text,
  role_title text,
  constraint faq_answer_targets_not_empty
    check (school is not null or course is not null or role_title is not null)
);

create index if not exists idx_faq_answer_targets_answer on public.faq_answer_targets (answer_id);
create index if not exists idx_faq_answer_targets_lookup on public.faq_answer_targets (school, course, role_title);

-- ============================================================
-- 5) 質問ログ
-- ============================================================
-- 「答えられなかった質問」を集めて次のQ&Aを足すための記録。これが改善運用そのもの。
create table if not exists public.faq_query_log (
  id              uuid primary key default gen_random_uuid(),
  audience        text not null check (audience in ('internal', 'public')),
  raw_query       text not null,                       -- 実際に入力された言葉
  school          text,
  course          text,
  role_title      text,
  had_match       boolean not null,                    -- 候補を出せたか
  picked_topic_id uuid references public.faq_topics(id) on delete set null,
  created_at      timestamptz not null default now()
);

create index if not exists idx_faq_query_log_created on public.faq_query_log (created_at desc);
create index if not exists idx_faq_query_log_nomatch on public.faq_query_log (had_match, created_at desc);

-- ============================================================
-- 6) RLS
-- ============================================================
alter table public.faq_topics         enable row level security;
alter table public.faq_answers        enable row level security;
alter table public.faq_answer_targets enable row level security;
alter table public.faq_query_log      enable row level security;

-- 閲覧：公開中のものは全員が読める。未公開・予約中は編集者だけ。
-- これにより「下書きや予約中の回答が一般の利用者に見える」事故を、画面ではなくDBで防ぐ。
create policy "faq_topics_select"
  on public.faq_topics for select to authenticated
  using (is_published = true or public.can_edit_faq());

-- 回答は「今日この回答が有効か」で絞る。予約分（valid_from が未来）は編集者にしか見えない。
-- 日付は必ずJSTで判定する（UTCだと日本の朝9時までズレる）
-- 🚨 親の質問が未公開なら回答も見せない。日付だけで判定すると、下書き中の質問に
--    ぶら下がった回答の本文が、画面に出ていなくてもAPI経由で読めてしまう。
create policy "faq_answers_select"
  on public.faq_answers for select to authenticated
  using (
    public.can_edit_faq()
    or (
      valid_from is not null
      and valid_from <= ((now() at time zone 'Asia/Tokyo')::date)
      and (valid_until is null or valid_until >= ((now() at time zone 'Asia/Tokyo')::date))
      and exists (
        select 1 from public.faq_topics t
        where t.id = faq_answers.topic_id and t.is_published = true
      )
    )
  );

-- 対象の指定自体は秘密ではない（回答の本文は上のポリシーで守られている）
create policy "faq_answer_targets_select"
  on public.faq_answer_targets for select to authenticated
  using (true);

-- 書き込み：管理者とQ&A編集専用アカウントだけ
create policy "faq_topics_write"
  on public.faq_topics for all to authenticated
  using (public.can_edit_faq()) with check (public.can_edit_faq());

create policy "faq_answers_write"
  on public.faq_answers for all to authenticated
  using (public.can_edit_faq()) with check (public.can_edit_faq());

create policy "faq_answer_targets_write"
  on public.faq_answer_targets for all to authenticated
  using (public.can_edit_faq()) with check (public.can_edit_faq());

-- ログ：誰でも自分の質問を記録できる。読めるのは編集者だけ
create policy "faq_query_log_insert"
  on public.faq_query_log for insert to authenticated
  with check (true);

create policy "faq_query_log_select"
  on public.faq_query_log for select to authenticated
  using (public.can_edit_faq());
