-- ナビの「📦 備品精算」バッジに「未確認のやりとり」を足すための件数関数。
--
-- ■ 何を数えるか
-- 自分が関わった申請のうち、「自分以外の人の投稿で、自分がまだ確認していないもの」を
-- 1件でも持つ申請の数。**申請の数**であって投稿の数ではない
-- （1回の共有でファイルを3つ貼ると3行入るので、投稿で数えると3件に見えてしまう）。
--
-- ■ 判定は画面側と同じ式にすること
-- client/src/components/PurchaseCommentThread.tsx の isUnseen と同じ：
--   自分以外が書いた ∧ created_at > 自分の last_seen_at（行が無ければ全部が未確認）
-- 🚨 片方だけ直すと「バッジは1件と言うのに、開いても赤いものが無い」が起きる。
--    どちらかを触るときは必ず両方を見ること。
--
-- ■ なぜ RPC にするのか
-- クライアントで組むと「全コメント＋自分の確認記録」を取ってきて数えることになる。
-- Supabase は件数指定が無いと1,000行で黙って打ち切るため、
-- 数年後に**エラーも出さずバッジだけ静かに減る**。数値1つを返す関数ならこの問題が起きない。
--
-- ■ なぜ SECURITY INVOKER でよいのか
-- 件数を絞っているのは RLS ではなく下の where 句（関わった人だけ）。
-- INVOKER なら RLS が二重の網として効き、将来ポリシーが増えても自動で追従する。
-- （DEFINER にすると、ここの where を間違えた瞬間に全社の件数が漏れる）
--
-- ■ 🚨 対象を「関わった申請」に絞る理由
-- RLS は親の申請に委譲しており、マネージャー以上は**全社の申請が見える**。
-- 素直に「見える申請の未確認」を数えると、自分と無関係な他部署の共有まで
-- マネージャー全員のバッジに積み上がる。しかもベル通知と違って
-- **バッジは押すまで消えない**ので、消せない赤を作ることになる。
-- 通知の宛先（マネージャー以上全員を含む）とは意図的に別の範囲にしている。
--
-- ■ 🚨 「過去にこのやりとりに書いた人」を必ず含める
-- 承認者でない経理が請求書について質問した場合、その答えが来ても
-- 承認者の一覧には入らないため数えられない。一番答えを待っている人が漏れる。

create or replace function public.purchase_unconfirmed_count()
returns integer
language sql
stable
security invoker
set search_path = public
as $$
  select count(*)::int
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
$$;

comment on function public.purchase_unconfirmed_count() is
  '自分が関わった申請のうち、未確認のやりとりを持つ申請の件数。ナビの📦バッジと履歴タブのバッジで使う';

-- 🚨 Supabase は新しい関数に anon の実行権限を自動で付ける。
--    revoke ... from public だけでは外れないので、anon も明示的に外すこと。
revoke execute on function public.purchase_unconfirmed_count() from public;
revoke execute on function public.purchase_unconfirmed_count() from anon;
grant  execute on function public.purchase_unconfirmed_count() to authenticated;
