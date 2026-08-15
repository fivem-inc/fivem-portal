-- ============================================================
-- FAQ「違う場合はこちら」（関連質問への相互参照）
-- ============================================================
--
-- 【なぜ要るか】
-- 似た質問が複数ある（例：25日ルールが3種類＝プラスコースの予約／会員の振替／
-- ウェルネスの予約）。間違えて開いた人が1タップで正しい回答に移れるよう、
-- 回答の下に「違う場合はこちら」のボタンを出す。
-- 社外版v4の攻撃検証で見つかった取り違え（実害＝メール問い合わせ）への対策。
--
-- 【uuid[] の列ではなくテーブルで持つ理由】
-- 参照先の質問が削除されたとき、配列だと「押しても飛ばないボタン」が静かに残る。
-- 外部キー＋on delete cascade なら、削除と同時にボタンも自動で消える。
create table if not exists public.faq_topic_relations (
  id               uuid primary key default gen_random_uuid(),
  topic_id         uuid not null references public.faq_topics(id) on delete cascade,
  related_topic_id uuid not null references public.faq_topics(id) on delete cascade,
  -- ボタンに出す文言。質問文そのままだと長い（例「翌月の枠が表示されません／
  -- 翌月分はいつから予約できますか？」）ので、短い言い換えを持てるようにする。
  -- null なら参照先の質問文をそのまま出す
  label            text,
  sort_order       integer not null default 0,
  constraint faq_topic_relations_no_self check (topic_id <> related_topic_id),
  constraint faq_topic_relations_unique unique (topic_id, related_topic_id)
);

create index if not exists idx_faq_topic_relations_topic on public.faq_topic_relations (topic_id);

alter table public.faq_topic_relations enable row level security;

-- 閲覧：親の質問が読める人なら読める（未公開の質問の関連は編集者にしか見えない）
create policy "faq_topic_relations_select"
  on public.faq_topic_relations for select to authenticated
  using (
    public.can_edit_faq()
    or exists (
      select 1 from public.faq_topics t
      where t.id = faq_topic_relations.topic_id and t.is_published = true
    )
  );

-- 書き込み：管理者とQ&A編集専用アカウントだけ
create policy "faq_topic_relations_write"
  on public.faq_topic_relations for all to authenticated
  using (public.can_edit_faq()) with check (public.can_edit_faq());

-- ============================================================
-- faq_public_data() に関連質問を足す（作り直し）
-- ============================================================
-- 🚨 参照先のID・文言だけを返す。参照先が「今日出せる状態か」の判定は
--    ここではやらない：ウィジェットは全データを一度に受け取るので、
--    「返ってきた一覧に無いIDのボタンは出さない」だけで
--    非公開・期限切れの参照先ボタンが自然に消える（判定を2か所に書かない）。
create or replace function public.faq_public_data()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with today as (
    -- 日付は必ずJSTで判定する（UTCだと日本の朝9時まで前日扱いになる）
    select (now() at time zone 'Asia/Tokyo')::date as d
  ),
  valid_answers as (
    select
      a.id, a.topic_id, a.body, a.source_label, a.source_url, a.valid_from,
      coalesce(
        (
          select jsonb_agg(jsonb_build_object(
                   'school', tg.school,
                   'course', tg.course,
                   'role_title', tg.role_title
                 ))
          from public.faq_answer_targets tg
          where tg.answer_id = a.id
        ),
        '[]'::jsonb
      ) as targets
    from public.faq_answers a
    cross join today
    where a.valid_from is not null
      and a.valid_from <= today.d
      and (a.valid_until is null or a.valid_until >= today.d)
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', t.id, 'category', t.category, 'question', t.question,
        'keywords', t.keywords, 'is_featured', t.is_featured,
        'sort_order', t.sort_order, 'answers', t.ans,
        'related', t.rel
      )
      order by t.sort_order, t.created_at
    ),
    '[]'::jsonb
  )
  from (
    select
      tp.id, tp.category, tp.question, tp.keywords,
      tp.is_featured, tp.sort_order, tp.created_at,
      (
        select jsonb_agg(jsonb_build_object(
                 'id', va.id, 'body', va.body,
                 'source_label', va.source_label, 'source_url', va.source_url,
                 'valid_from', va.valid_from, 'targets', va.targets
               ))
        from valid_answers va
        where va.topic_id = tp.id
      ) as ans,
      coalesce(
        (
          select jsonb_agg(
                   jsonb_build_object('topic_id', r.related_topic_id, 'label', r.label)
                   order by r.sort_order
                 )
          from public.faq_topic_relations r
          where r.topic_id = tp.id
        ),
        '[]'::jsonb
      ) as rel
    from public.faq_topics tp
    where tp.audience = 'public'
      and tp.is_published = true
  ) t
  where t.ans is not null;
$$;

comment on function public.faq_public_data() is
  'お客様向けFAQ。公開中かつ今日有効な回答＋関連質問を返す。未ログインからも呼べる唯一の入口';
