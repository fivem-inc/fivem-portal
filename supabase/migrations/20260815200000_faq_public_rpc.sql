-- ============================================================
-- 社外版FAQを、ログインしていないお客様に見せるための入口
-- ============================================================
--
-- 【なぜRPCが要るか】
-- faq_topics / faq_answers のRLSは全て「to authenticated」なので、
-- 未ログインのお客様は1行も読めない（設計としてはこれが正しい）。
-- テーブルを anon に開放すると下書き・予約中の回答まで漏れるため、
-- SECURITY DEFINER の関数を1枚だけ用意し、そこを唯一の入口にする。
--
-- 🚨 SECURITY DEFINER はRLSを迂回する。つまり下のWHERE句が防壁のすべて。
--    ・audience = 'public'   … 社内向けQ&Aを絶対に出さない
--    ・is_published = true   … 下書きの質問を出さない
--    ・valid_from / valid_until をJSTの当日で判定 … 予約中・期限切れの回答を出さない
--
-- 🚨 返す列は1つずつ名前で書く。to_jsonb(行) や select * を使ってはいけない。
--    faq_topics には review_note（★要確認メモ）、faq_answers には refresh_note が
--    あり、「この金額は未確認」のような社内メモが入る。行ごと返す書き方にすると
--    将来列が増えたときに自動でお客様に漏れる。
--
-- 🚨 検索の照合（どの質問が近いか）はここではやらない。
--    採点ルールをSQLにも書くと「同じ意味を2か所に持つ」形になり、
--    このプロジェクトが繰り返し踏んでいる事故と同型になる。
--    照合は client/src/lib/faq.ts の matchFaqTopics 1つに集約したまま、
--    この関数は「今日出してよいデータ一式」を渡すだけにする。

-- ============================================================
-- 1) 公開データの取得
-- ============================================================
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
      a.id,
      a.topic_id,
      a.body,
      a.source_label,
      a.source_url,
      a.valid_from,
      coalesce(
        (
          select jsonb_agg(
                   jsonb_build_object(
                     'school',     tg.school,
                     'course',     tg.course,
                     -- 役職は社内向けの概念。社外の回答に付いていたら
                     -- 「誰にも当てはまらない」となり共通回答に落ちるのが正しいので、
                     -- 省略せずそのまま返す（省略すると全員向けに化ける）
                     'role_title', tg.role_title
                   )
                 )
          from public.faq_answer_targets tg
          where tg.answer_id = a.id
        ),
        '[]'::jsonb
      ) as targets
    from public.faq_answers a
    cross join today
    where a.valid_from is not null           -- null＝いつから出すか未定の下書き
      and a.valid_from <= today.d
      and (a.valid_until is null or a.valid_until >= today.d)
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id',          t.id,
        'category',    t.category,
        'question',    t.question,
        'keywords',    t.keywords,
        'is_featured', t.is_featured,
        'sort_order',  t.sort_order,
        'answers',     t.ans
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
        select jsonb_agg(
                 jsonb_build_object(
                   'id',           va.id,
                   'body',         va.body,
                   'source_label', va.source_label,
                   'source_url',   va.source_url,
                   'valid_from',   va.valid_from,
                   'targets',      va.targets
                 )
               )
        from valid_answers va
        where va.topic_id = tp.id
      ) as ans
    from public.faq_topics tp
    where tp.audience = 'public'
      and tp.is_published = true
  ) t
  -- 今日出せる回答が1件も無い質問は返さない
  -- （質問だけ出て「答えがありません」になるのを防ぐ）
  where t.ans is not null;
$$;

comment on function public.faq_public_data() is
  'お客様向けFAQ。公開中かつ今日有効な回答だけを返す。未ログインからも呼べる唯一の入口';

-- ============================================================
-- 2) 質問ログ（答えられなかった質問を集めて次のQ&Aを足すための記録）
-- ============================================================
create or replace function public.faq_public_log(
  p_raw_query       text,
  p_had_match       boolean,
  p_school          text default null,
  p_course          text default null,
  p_picked_topic_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_topic uuid;
begin
  -- 空の記録は残さない
  if p_raw_query is null or btrim(p_raw_query) = '' then
    return;
  end if;

  -- 選ばれた質問は「社外向けかつ公開中」のものだけ受け付ける。
  -- 呼び出し側は誰でも叩けるので、社内向けQ&AのIDを渡されても記録しない
  if p_picked_topic_id is not null then
    select id into v_topic
    from public.faq_topics
    where id = p_picked_topic_id
      and audience = 'public'
      and is_published = true;
  end if;

  insert into public.faq_query_log
    (audience, raw_query, school, course, role_title, had_match, picked_topic_id)
  values
    ('public',                      -- 社内向けとして記録させない（呼び出し側に選ばせない）
     left(p_raw_query, 500),
     left(p_school, 100),
     left(p_course, 100),
     null,                          -- 役職は社外の入口では持たない
     coalesce(p_had_match, false),
     v_topic);
end;
$$;

comment on function public.faq_public_log(text, boolean, text, text, uuid) is
  'お客様向けFAQの質問ログ。未ログインからも呼べる。audienceはpublic固定';

-- ============================================================
-- 3) 実行権限
-- ============================================================
-- 関数は既定で public（全ロール）に実行権限が付く。
-- 意図を明示するため一度取り上げてから、必要な2つのロールにだけ配り直す。
revoke all on function public.faq_public_data() from public;
revoke all on function public.faq_public_log(text, boolean, text, text, uuid) from public;

-- anon＝お客様（未ログイン）、authenticated＝管理者が動作確認するとき
grant execute on function public.faq_public_data() to anon, authenticated;
grant execute on function public.faq_public_log(text, boolean, text, text, uuid) to anon, authenticated;
