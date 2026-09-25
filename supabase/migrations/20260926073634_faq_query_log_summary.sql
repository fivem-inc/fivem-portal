-- 2026-09-26 社内FAQの集計：検索した言葉の数え上げを DB 側（RPC）に寄せる
--
-- 背景
--   管理画面「利用状況の集計」の「検索して見つからなかった言葉」「社内FAQで検索された言葉」は、
--   faq_query_log の行を画面に読んでから数えていた。読む件数は 500 件で打ち切り（黙って切れないよう
--   画面に断りは出していた）。件数が多い月ほど、多い順の並びが実際と違う状態になり得た。
--   本番の実測（2026-09-26）：全 106 件・多い月でも 34 件なので、まだ打ち切りは起きていない。
--
-- 直し方
--   期間と社内/社外で group by した結果だけを返す関数を1つ作り、画面はそれを呼ぶ。行を運ばないので上限が要らない。
--   🚨 security definer にしない（呼んだ人の権限がそのまま効く＝faq_query_log の select は can_edit_faq() の人だけ）。
--      既存の faq_public_event_summary と同じ形。
--   🚨 Supabase は新しい関数に anon の実行権限を自動で付ける。`revoke … from public` では外れないので anon から明示的に外す
--      （2026-09-05 に取り消し版の実測で確認済み）。

create or replace function public.faq_query_log_summary(p_from timestamptz, p_to timestamptz)
returns table (is_public boolean, raw_query text, n bigint, miss bigint)
language sql
stable
as $$
  select (l.audience = 'public')                  as is_public,
         l.raw_query,
         count(*)                                 as n,
         count(*) filter (where not l.had_match)  as miss
    from public.faq_query_log l
   where l.created_at >= p_from
     and l.created_at <  p_to
   group by (l.audience = 'public'), l.raw_query;
$$;

comment on function public.faq_query_log_summary(timestamptz, timestamptz) is
  '社内FAQの集計：期間内に検索された言葉を、社外（is_public）／社内で分けて数える。'
  'n＝検索された回数（同じ方が3回検索すれば3）、miss＝そのうち候補が0件だった回数。'
  '画面（FaqAnalytics）は社外は miss の行だけ、社内は全部を出す。呼んだ人の権限がそのまま効く（security definer ではない）。';

revoke all     on function public.faq_query_log_summary(timestamptz, timestamptz) from public;
revoke execute on function public.faq_query_log_summary(timestamptz, timestamptz) from anon;
grant  execute on function public.faq_query_log_summary(timestamptz, timestamptz) to authenticated;
