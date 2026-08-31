-- 備品購入申請の「質問・ファイル共有」に、①投稿の種別（質問／共有）と
-- ②「確認した」の記録を持たせる。あわせて③本文が空でも共有できるように直す。
--
-- ■ きっかけ（2026-09-01 実機で判明）
-- 承認後に確定見積書を共有しただけの投稿に、赤い「回答待ち」が出た。
-- 判定が「最後の発言が自分以外か」だけで、質問と共有を区別していなかったため、
-- 申請者と承認者5名の全員に「あなたが答える番」と読める表示が出ていた。
-- 共有に返事は要らないので誰も答えず、赤は永久に残る。
--
-- ■ なぜ「最後の投稿にファイルが付いていたら出さない」で済ませないのか
--   質問 → （誰も答えない） → 経理が請求書を共有
-- という並びで、答えていない質問があるのに赤が消える。やりとりが伸びるほど外れる。
-- 投稿した本人にしか分からない意図なので、送信時に種別として持たせる。
--
-- ■ 入力の手間は増やさない（2026-09-01 ユーザー決定）
-- 送信欄の2択は既定を自動で寄せる（添付あり→共有／本文だけ→質問）。
-- 画面には説明文を足さない。「質問」という語だけで返事が要ることは通じる。

-- ============================================================
-- ③ 本文が空でも、ファイルが付いていれば投稿できるようにする
--
-- 🚨 これは 20260831700000（共有ファイル）の積み残しのバグ。
--    コードは「ファイルだけの共有」と「複数ファイル」を作れる状態だったが、
--    2件目以降の行は body='' で入るため、この CHECK に弾かれて
--    insert 全体が失敗していた（本番で実測確認済み・2026-09-01）。
--    1件＋本文のときだけ通るので、実機確認をすり抜けた。
-- ============================================================
alter table public.purchase_request_comments
  drop constraint if exists purchase_request_comments_body_check;

alter table public.purchase_request_comments
  add constraint purchase_request_comments_body_check
  check (btrim(body) <> '' or file_path is not null);

-- ============================================================
-- ① 投稿の種別
--   question … 返事がほしい。赤い「回答待ち」が出る
--   share    … 共有。返事は不要。「確認した」で終われる
-- 既定は question。列を足しただけの状態でも、いままでと同じ意味になる。
-- ============================================================
alter table public.purchase_request_comments
  add column if not exists kind text not null default 'question';

alter table public.purchase_request_comments
  drop constraint if exists purchase_request_comments_kind_check;

alter table public.purchase_request_comments
  add constraint purchase_request_comments_kind_check
  check (kind in ('question', 'share'));

-- 既存の投稿には種別が無い。ファイルが付いていれば共有・なければ質問とみなす。
-- （種別を持たせる前の唯一の手がかりがファイルの有無のため）
update public.purchase_request_comments
   set kind = 'share'
 where file_path is not null and kind <> 'share';

comment on column public.purchase_request_comments.kind is
  'question=質問（回答待ちが出る） / share=共有（返事不要・確認したで終われる）';

-- ============================================================
-- ② 「確認した」＝このやりとりをどこまで見たか
--
-- 🚨 投稿1行ごとに持たない。1回の送信でファイルを2つ共有すると2行入るので、
--    行ごとに置くとボタンが2つ並んで押し忘れる。
--    「どこまで見たか」を1人1申請につき1行だけ持てば、
--    ファイルが何件でもボタンは1つで済み、やりとりが何十件に伸びても行は増えない。
--    新しい投稿が来れば last_seen_at より新しいので、ボタンがまた出る。
--
-- 🚨 通知は作らない。「確認した」で46人に通知が飛ぶと、押すこと自体が嫌がられる。
--    （新しい通知は「設定が無い＝全員に送る」作りのため・開発ルール）
-- ============================================================
create table if not exists public.purchase_request_comment_reads (
  purchase_request_id uuid not null
    references public.purchase_requests(id) on delete cascade,
  -- 名義の詐称ができないよう既定値で入れる（comments の author_id と同じ作り）
  user_id             uuid not null default auth.uid()
    references auth.users(id) on delete cascade,
  last_seen_at        timestamptz not null default now(),
  primary key (purchase_request_id, user_id)
);

alter table public.purchase_request_comment_reads enable row level security;

-- 🚨 可視範囲は親の purchase_requests に完全委譲する（comments と同じ方針）。
--    purchase_requests の SELECT ポリシーは6本に分散しており、条件を書き写すと
--    必ず食い違ううえ、食い違ってもエラーが出ない。
drop policy if exists prcr_select on public.purchase_request_comment_reads;
create policy prcr_select on public.purchase_request_comment_reads
  for select to authenticated
  using (exists (
    select 1 from public.purchase_requests pr
    where pr.id = purchase_request_comment_reads.purchase_request_id
  ));

drop policy if exists prcr_insert on public.purchase_request_comment_reads;
create policy prcr_insert on public.purchase_request_comment_reads
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.purchase_requests pr
      where pr.id = purchase_request_comment_reads.purchase_request_id
    )
  );

-- UPDATE は自分の行だけ。新しい共有が来たら last_seen_at を進めるため upsert する。
drop policy if exists prcr_update on public.purchase_request_comment_reads;
create policy prcr_update on public.purchase_request_comment_reads
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- DELETE のポリシーは作らない（「確認した」は取り消さない記録）

-- 🚨 Supabase は新しいテーブルに anon の権限を自動で付ける。ログイン前提の機能なので外す。
revoke all on public.purchase_request_comment_reads from anon;
