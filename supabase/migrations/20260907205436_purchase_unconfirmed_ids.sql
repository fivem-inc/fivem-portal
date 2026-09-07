-- 未確認の「件数」と「対象の申請ID」を、同じ1つの判定から出せるようにする
--
-- 【なぜ要るか】
-- 2026-09-07、実機で「備品の履歴に 1 と出ているのに見られない」という報告があった。
-- 原因は「数えている範囲」と「見せている範囲」の食い違い：
--   ・バッジ … purchase_unconfirmed_count() に日付条件が無い（いつの申請でも数える）
--   ・一覧　 … 既定が「今月・申請日で絞る」
-- 対象の申請が 2026-07-27 のものだったため、8月も9月も一覧に出ず、
-- バッジだけが「1」と言い続けていた。利用者は探しようがなく、2週間気づかれなかった。
--
-- 対策として履歴の先頭に「確認をお願いします」の帯を出すが、
-- 🚨 その判定をクライアントに書き直すと、今度は逆向きの食い違いが生まれる。
--    履歴は purchase_requests を無条件に読んでおり、RLS（pr_manager_plus_select）で
--    マネージャー・社長・管理者は全社の申請が見える。
--    「関わった人だけ」という下の where を画面側で書き忘れる／書き間違えると、
--    無関係な申請にまで帯が出て、しかもバッジには数えられない（帯は3件・バッジは1）。
--    どちらも「間違っていない」ので原因にたどり着けない。
--
-- → 判定はこの関数1つに集約し、件数はそれを数えるだけにする。
--    これがこの案件の最重要ルール「同じ意味の判定を2か所に書かない」の実装。
--
-- 🚨 下の where は 2026-09-07 に本番の pg_get_functiondef から写したもの。
--    リポジトリのファイルではなく実定義から起こしている（古い版で上書きする事故を避けるため）。
-- 🚨 security definer にしない（元の関数も定義者権限ではない）。呼んだ人のRLSがそのまま効く。
--    fail-close に倒れる＝見えない申請は数えないので、漏らす方向にしか間違わない。

create or replace function public.purchase_unconfirmed_ids()
returns setof uuid
language sql
stable
set search_path to 'public'
as $function$
  select r.id
  from public.purchase_requests r
  where (
      -- 関わった人だけ。🚨 配列は null があり得るので必ず coalesce を通す
      r.user_id   = auth.uid()
      or r.leader_id = auth.uid()
      or auth.uid() = any (coalesce(r.requested_manager_ids, '{}'::uuid[]))
      or auth.uid() = any (coalesce(r.shared_manager_ids,    '{}'::uuid[]))
      or auth.uid() = any (coalesce(r.board_approver_ids,    '{}'::uuid[]))
      or exists (
        select 1 from public.purchase_request_comments c
        where c.purchase_request_id = r.id and c.author_id = auth.uid()
      )
    )
    -- 🚨 exists で書く＝やりとりが0件の申請は数えない。
    --    left join と last_seen_at is null で書くと、投稿が1件も無い申請まで
    --    「未確認」として全部数えてしまう
    and exists (
      select 1
      from public.purchase_request_comments c
      where c.purchase_request_id = r.id
        and c.author_id <> auth.uid()
        and c.created_at > coalesce(
              (select s.last_seen_at
                 from public.purchase_request_comment_reads s
                where s.purchase_request_id = r.id
                  and s.user_id = auth.uid()),
              '-infinity'::timestamptz)
    )
$function$;

comment on function public.purchase_unconfirmed_ids() is
  '未確認のやりとりがある申請のID。件数（purchase_unconfirmed_count）も画面の帯も、必ずこれを使うこと。判定を2か所に書かない';

-- 件数は「上の関数を数えるだけ」にする。
-- 🚨 引数は無いまま（signature を変えない）＝ create or replace で置き換わる。
--    引数を変えると同名の関数が2つになり PostgREST が PGRST203 で全滅する（過去に発生）
create or replace function public.purchase_unconfirmed_count()
returns integer
language sql
stable
set search_path to 'public'
as $function$
  select count(*)::int from public.purchase_unconfirmed_ids()
$function$;

-- 権限は既存の count と同じ形にそろえる（2026-09-07 実測：anon=false / authenticated=true）
revoke all on function public.purchase_unconfirmed_ids() from public;
-- 🚨 Supabase は新しい関数に anon の実行権限を自動で付ける。from public では外れない
revoke execute on function public.purchase_unconfirmed_ids() from anon;
grant  execute on function public.purchase_unconfirmed_ids() to authenticated;

-- 適用後に実測すること（読み取りのみ）
-- select has_function_privilege('anon','public.purchase_unconfirmed_ids()','execute');          -- false
-- select has_function_privilege('authenticated','public.purchase_unconfirmed_ids()','execute'); -- true
