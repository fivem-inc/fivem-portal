-- 備品購入申請の「質問・回答」
--
-- きっかけ：自己受理・リーダー受理の申請は「見るしかできない」。
--   マネージャーが質問したいときは意見の「その他」に書くしかなく、
--   しかも visible_to_applicant の初期値が false なので申請者に届いていなかった。
--
-- 🚨 意見テーブル（purchase_request_manager_opinions）には相乗りしない。
--    全員回答ゲートが「そのテーブルの行数」を数えているため（20260712000000 / 20260744000000）、
--    質問を混ぜると回答済み件数が水増しされ、全員の回答が揃う前に最終決定できてしまう。
--
-- 🚨 可視範囲は「親の purchase_requests 行が見えるか」に完全委譲する。
--    purchase_requests の SELECT ポリシーは6本に分散しており
--    （申請者／マネージャー以上／管理者／leader_id／requested／shared／board）、
--    条件をコピーすると必ず食い違う。しかも食い違ってもエラーが出ない
--    （多すぎれば画面に出ないまま権限だけ広がる／少なすぎれば会話だけ空になる）。
--    EXISTS の内側にも親の RLS が効くので、親委譲なら将来ポリシーが増えても自動で追従する。
--    前例：purchase_request_items の pr_items_select（20260718300000:19-25）

create table if not exists public.purchase_request_comments (
  id                  uuid primary key default gen_random_uuid(),
  purchase_request_id uuid not null references public.purchase_requests(id) on delete cascade,
  -- 既定値で入れる＝名義の詐称ができない。ユーザー削除時は申請ごと消える運用に合わせて cascade
  author_id           uuid not null default auth.uid() references auth.users(id) on delete cascade,
  body                text not null check (btrim(body) <> ''),
  created_at          timestamptz not null default now()
);

create index if not exists idx_prc_request
  on public.purchase_request_comments (purchase_request_id, created_at);

alter table public.purchase_request_comments enable row level security;

-- SELECT：親が見えれば見える（条件をここに書かない＝二重管理を作らない）
drop policy if exists prc_select on public.purchase_request_comments;
create policy prc_select on public.purchase_request_comments
  for select to authenticated
  using (exists (
    select 1 from public.purchase_requests pr
    where pr.id = purchase_request_comments.purchase_request_id
  ));

-- INSERT：同条件＋自分名義のみ
drop policy if exists prc_insert on public.purchase_request_comments;
create policy prc_insert on public.purchase_request_comments
  for insert to authenticated
  with check (
    author_id = auth.uid()
    and exists (
      select 1 from public.purchase_requests pr
      where pr.id = purchase_request_comments.purchase_request_id
    )
  );

-- UPDATE / DELETE のポリシーは作らない＝誰も書き換えられない記録にする
-- （安否確認の対応記録 20260804300000 と同じ方針）

-- ============================================================
-- 通知設定
--   🚨 site 行が無いと getNotificationTemplate が null を返し、ベル通知そのものが飛ばない
--   🚨 push は push-dispatch の EVENT_MAP 登録とセット（未登録だと無言で捨てられる）
--   メールは作らない（Resend 無料枠は1日100通。ベル＋プッシュ＋バナーで足りる）
--   ⚠️ 本文に「お知らせ」「リマインド」「メッセージが届き」を入れないこと。
--      App.tsx の連絡板判定が先に効いてタップで /board に飛ぶ
-- ============================================================
insert into public.notification_settings (event_key, channel, enabled, recipient, subject, template)
select 'purchase_request:comment_added', 'site', true, null, null,
       '💬 {{投稿者名}}さんが「{{品目名}}」の申請に書き込みました'
where not exists (
  select 1 from public.notification_settings
   where event_key = 'purchase_request:comment_added' and channel = 'site'
);

insert into public.notification_settings (event_key, channel, enabled, recipient, subject, template)
select 'purchase_request:comment_added', 'push', true, null, null, null
where not exists (
  select 1 from public.notification_settings
   where event_key = 'purchase_request:comment_added' and channel = 'push'
);
