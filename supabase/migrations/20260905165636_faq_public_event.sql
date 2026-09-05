-- 社外FAQ（お客様向けウィジェット）の利用状況を記録する
--
-- 【目的】
-- 「どの回答を書き直すべきか」「どんな質問を新しく足すべきか」を、勘ではなく記録で判断する。
-- 見たいのは アクセス数そのものではなく、**うまくいかなかった出口** の内訳。
--
-- 【なぜ新しい表を作るか（既存 faq_query_log を拡張しない理由）】
-- faq_query_log は raw_query / had_match が not null で、「言葉を伴わない出来事」
-- （ページを開いた・問い合わせに進んだ）を入れられない。緩めると既存70件の意味が変わる。
-- しかも社内 /help の logFaqQuery が同じ表に直接 insert しており、読み手にも影響が出る。
-- → 触らずに別の表を足す。検索語は今までどおり faq_query_log が持つ（この表には持たない）。
--
-- 🚨 この表に raw_query（お客様の自由入力）は置かない。
--    個人情報が混ざり得るものの保存場所を2か所に増やさないため。
--    「答えられなかった言葉」は faq_query_log の had_match = false から取る。
--
-- 【記録する出来事】kind
--   page_view     ページを開いた（1セッション1回）
--   topic_view    回答が表示された（1セッション×1質問1回）
--   contact       問い合わせの案内に進んだ（reason で理由を分ける）
--   contact_click 電話・フォームを実際に押した（channel で分ける）
--   solved        「はい（解決した）」を押した
--
-- 【contact の reason ＝ そのまま「やるべきこと」】
--   unsolved       回答を読んだが解決しない          → その回答を書き直す
--   search_nomatch 検索候補は出たが的外れ            → 検索の手がかり語を足す
--   search_nohit   検索候補が0件                     → 新しい質問と回答を作る
--   unknown        校・コースに該当する回答が無い    → 既存の回答に対象を足す
--   noanswer       質問はあるが有効な回答が無い      → 下書きを公開する／期限を延ばす
--   load_error     読み込みに失敗した                → 不具合。運用で気づくため
--
-- 【この設計で捨てたもの】
-- ・resolved 列（true/false）は作らない。「いいえ」は問い合わせへ進むので
--   false が一度も入らない死に列になる。解決率は solved ÷ (solved + contact(unsolved)) で出す。
-- ・(topic_id, created_at) の索引は作らない。期間で切って kind ごとに数える使い方では効かない。

-- ============================================================
-- 1) 記録の表
-- ============================================================
create table if not exists public.faq_public_event (
  id             uuid primary key default gen_random_uuid(),
  kind           text not null
                 check (kind in ('page_view','topic_view','contact','contact_click','solved')),
  reason         text
                 check (reason is null or reason in
                        ('unsolved','search_nomatch','search_nohit','unknown','noanswer','load_error')),
  channel        text check (channel is null or channel in ('tel','form')),
  topic_id       uuid references public.faq_topics(id)  on delete set null,
  answer_id      uuid references public.faq_answers(id) on delete set null,
  -- 🚨 質問文の写し。FaqTab の削除は物理削除なので、質問を消すと topic_id が null になり
  --    「解決しなかった質問」の集計が静かに目減りする。読めるように写しを持つ
  topic_question text,
  school         text,
  course         text,
  -- 端末の一時ID（タブを閉じると消える）。個人は特定しない。取れない端末では null
  session_id     text,
  created_at     timestamptz not null default now(),
  -- 🚨 制約は「片方向」にする。双方向（(kind='contact') = (reason is not null)）にすると
  --    渡し忘れた1件が例外で丸ごと消える。分析用の表は「欠けても残す」向きに倒す
  constraint faq_public_event_reason_only_contact
    check (reason  is null or kind = 'contact'),
  constraint faq_public_event_channel_only_click
    check (channel is null or kind = 'contact_click')
);

comment on table public.faq_public_event is
  '社外FAQウィジェットの利用記録。書き込みは faq_public_event_log 経由のみ。検索語は faq_query_log 側にある';

-- 🚨 索引には必ず名前と if not exists を付ける（既存 faq_query_log と同じ流儀）。
--    名前を省くと流し直したときに別名で二重に張られ、エラーも出ない
create index if not exists idx_faq_public_event_created on public.faq_public_event (created_at desc);
create index if not exists idx_faq_public_event_kind    on public.faq_public_event (kind, created_at desc);

-- ============================================================
-- 2) 1日あたりの上限（膨張を止める）
-- ============================================================
-- 🚨 この入口は匿名の誰でも叩ける（anon キーは公開ビルドに埋まっている）。
--    2026-08-20 に cron の記録が 130,817件・115MB まで膨らみ、
--    「上限に達すると読み取り専用になって申請が保存できなくなる」状態の一歩手前まで行っている。
--    FAQの集計という補助機能が、基幹業務を止める経路になってはいけない。
-- 🚨 session_id はクライアントが自由に作れるので、session 単位の制限は乱数を変えれば破られる。
--    日単位の全体上限だけが実効的な防壁になる。
create table if not exists public.faq_event_quota (
  day date primary key,
  n   integer not null default 0
);

-- ============================================================
-- 3) 書き込みの入口（RPC）
-- ============================================================
-- 既存 faq_public_log と同じ形：security definer ＋ search_path 固定 ＋ anon に execute。
-- 🚨 引数を増やすときは create or replace ではなく、先に drop function すること。
--    同名で引数違いの関数が2つできると PostgREST が PGRST203 で全滅する（過去に発生）。
--    drop function public.faq_public_event_log(text,text,text,uuid,uuid,text,text,text);
create or replace function public.faq_public_event_log(
  p_kind       text,
  p_reason     text default null,
  p_channel    text default null,
  p_topic_id   uuid default null,
  p_answer_id  uuid default null,
  p_school     text default null,
  p_course     text default null,
  p_session_id text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_topic    uuid;
  v_answer   uuid;
  v_question text;
  v_n        integer;
begin
  -- 知らない種類は黙って捨てる（画面のバグで意味のない行を増やさない）
  if p_kind not in ('page_view','topic_view','contact','contact_click','solved') then
    return;
  end if;

  -- 1日の上限。超えたら記録しないだけで、お客様の画面は止めない
  insert into public.faq_event_quota (day, n)
  values ((now() at time zone 'Asia/Tokyo')::date, 1)
  on conflict (day) do update set n = public.faq_event_quota.n + 1
  returning n into v_n;
  if v_n > 20000 then
    return;
  end if;

  -- 🚨 質問は「社外向けかつ公開中」のものだけ受け付ける。
  --    呼び出し側は誰でも叩けるので、社内向けQ&AのIDを渡されても記録しない
  --    （既存 faq_public_log と同じ考え方）。
  --    見つからなければ null にして、行そのものは残す（件数だけは失わない）
  if p_topic_id is not null then
    select t.id, left(t.question, 200)
      into v_topic, v_question
      from public.faq_topics t
     where t.id = p_topic_id
       and t.audience = 'public'
       and t.is_published = true;
  end if;

  -- 回答は「その質問にぶら下がっているもの」だけ受け付ける
  if p_answer_id is not null and v_topic is not null then
    select a.id into v_answer
      from public.faq_answers a
     where a.id = p_answer_id
       and a.topic_id = v_topic;
  end if;

  insert into public.faq_public_event
    (kind, reason, channel, topic_id, answer_id, topic_question, school, course, session_id)
  values
    (p_kind,
     -- 種類に合わない値は null に倒す（例外にして1件失うより、記録を残すほうを選ぶ）
     case when p_kind = 'contact'
           and p_reason in ('unsolved','search_nomatch','search_nohit','unknown','noanswer','load_error')
          then p_reason end,
     case when p_kind = 'contact_click' and p_channel in ('tel','form')
          then p_channel end,
     v_topic,
     v_answer,
     v_question,
     left(p_school, 50),
     left(p_course, 50),
     left(p_session_id, 64));
end;
$$;

-- ============================================================
-- 4) 集計（DB側で数える）
-- ============================================================
-- 🚨 security definer にしない（＝呼んだ人の権限がそのまま効く）。
--    権限の判定を画面とサーバーの2か所に書かないため。
-- 🚨 クライアントで1,000件ずつ読む方式は採らない。
--    この表は読んでいる最中も匿名から書き込まれ続けるので、
--    ページを送っている途中で新しい行が入り、二度読み・読み飛ばしが起きる。
create or replace function public.faq_public_event_summary(
  p_from timestamptz,
  p_to   timestamptz
)
returns table (
  kind           text,
  reason         text,
  channel        text,
  topic_id       uuid,
  topic_question text,
  school         text,
  course         text,
  n              bigint
)
language sql
stable
as $$
  -- 校・コースまで分けて返す。「西陣校を選んだら該当が無かった」を数えるために要る
  select e.kind,
         e.reason,
         e.channel,
         e.topic_id,
         max(e.topic_question) as topic_question,
         e.school,
         e.course,
         count(*)              as n
    from public.faq_public_event e
   where e.created_at >= p_from
     and e.created_at <  p_to
   group by e.kind, e.reason, e.channel, e.topic_id, e.school, e.course;
$$;

-- ============================================================
-- 5) RLS
-- ============================================================
alter table public.faq_public_event enable row level security;
alter table public.faq_event_quota  enable row level security;

-- 🚨 insert のポリシーは作らない。書き込みの入口は上のRPCだけにする
--    （既存 faq_query_log は authenticated に insert を開けているが、
--      こちらは匿名も通るので、入口を1つに絞るほうが締まる）
drop policy if exists "faq_public_event_select" on public.faq_public_event;
create policy "faq_public_event_select"
  on public.faq_public_event for select to authenticated
  using (public.can_edit_faq());

-- 上限の表は誰にも直接見せない（RPC の中からだけ触る）

-- ============================================================
-- 6) 実行権限
-- ============================================================
-- 🚨 Supabase は新しい関数に anon の実行権限を自動で付ける。
--    revoke ... from public では外れないので、明示的に付け外しする
revoke all on function public.faq_public_event_log(text,text,text,uuid,uuid,text,text,text) from public;
revoke all on function public.faq_public_event_summary(timestamptz, timestamptz)            from public;

-- 🚨 `revoke ... from public` では anon の権限が外れないことを、取り消し版の実測で確認済み
--    （2026-09-05：この revoke が無い状態で has_function_privilege('anon', ...) が true だった）。
--    anon から明示的に外すこと。集計は匿名に開けない（お客様が利用状況を読めてはいけない）
revoke execute on function public.faq_public_event_summary(timestamptz, timestamptz) from anon;

grant execute on function public.faq_public_event_log(text,text,text,uuid,uuid,text,text,text)
  to anon, authenticated;
grant execute on function public.faq_public_event_summary(timestamptz, timestamptz)
  to authenticated;

-- ============================================================
-- 7) 掃除（毎晩）
-- ============================================================
-- 🚨 記録を貯める仕組みを足すときは、必ず掃除する仕組みも一緒に作る。
--    JST 3:50（UTC 18:50）。既存の delete-old-notifications（UTC 18:00）と
--    purge-cron-history-daily（UTC 18:30）の後ろにずらしてある
select cron.unschedule('purge-faq-public-event')
where exists (select 1 from cron.job where jobname = 'purge-faq-public-event');

select cron.schedule(
  'purge-faq-public-event',
  '50 18 * * *',
  $$
    delete from public.faq_public_event where created_at < now() - interval '13 months';
    delete from public.faq_event_quota  where day        < (now() at time zone 'Asia/Tokyo')::date - 90;
  $$
);

-- ============================================================
-- 8) 適用後に実測すること（読み取りのみ）
-- ============================================================
-- select has_function_privilege('anon',
--   'public.faq_public_event_log(text,text,text,uuid,uuid,text,text,text)', 'execute');  -- true
-- select has_function_privilege('anon',
--   'public.faq_public_event_summary(timestamptz,timestamptz)', 'execute');              -- false
-- select relrowsecurity from pg_class where oid = 'public.faq_public_event'::regclass;   -- true
-- select count(*) from cron.job where jobname = 'purge-faq-public-event';                -- 1
