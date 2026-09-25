-- 2026-09-26 連絡板：送信トレイの「アーカイブ」を、お知らせ1件に1つの印から「お知らせ × 人」の記録に変える
--
-- 症状（2026-09-25 (130) で見つけ、ユーザー確定「これで直して」）
--   送信トレイのアーカイブは board_messages.outbox_hidden（お知らせ1件に1つの印）だった。
--   ところがお知らせは「送った本人」のほかに「写し（cc_user_ids）で見ている代表者」も送信トレイで見る。
--   ・管理者が写しで見ている他人のお知らせをアーカイブすると、**送った本人の送信トレイでもアーカイブに移る**
--     （本人は何もしていないのに一覧から消えたように見える）
--   ・管理者以外の代表者が同じことをすると、更新の権限（送信者本人か管理者）で弾かれて赤いエラー
--   ・写しの人は、送信者がアーカイブしたお知らせを**どこにも見られなかった**（写しの読み込みが outbox_hidden=false で絞っていた）
--
-- 直し方
--   受信トレイのアーカイブ（board_message_recipients.archived＝人ごと）と同じ持ち方にする。
--   新しい表 board_outbox_hidden（message_id × user_id）に「この人が片付けた」を1行で持つ。
--   🚨 board_messages.outbox_hidden の列は**消さない**（戻すときの値。画面はもう読まない）。
--   既存の印（本番3件・すべて送信者本人が付けたもの）は送信者のぶんとして写す。
--
-- 権限
--   ・読む・付ける・外す … 自分のぶんだけ（user_id = auth.uid()）。管理者も他人のぶんは触らない（人ごとの整理なので）
--   ・付けるときは、そのお知らせが**自分に見える**こと（board_messages の select 権限がそのまま効く）を条件にする。
--     見えないお知らせの ID を当てずっぽうで入れても何も起きないが、行だけ増えるのを防ぐ
--   ・🚨 Supabase は新しい表にも anon の権限を自動で付ける。明示的に外す
--
-- 効く場所（画面側・BoardPage.tsx）
--   loadOutbox（送信トレイの読み込み）／archiveOutboxMsg・unarchiveOutboxMsg（付ける・外す）だけ。
--   検索・対応状況・返信の数は触らない。

create table if not exists public.board_outbox_hidden (
  message_id uuid not null references public.board_messages(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

comment on table public.board_outbox_hidden is
  '送信トレイのアーカイブ（お知らせ × 人）。1行＝「この人が自分の送信トレイでこのお知らせを片付けた」。'
  '送った本人と、写し（cc_user_ids）で見ている代表者が、それぞれ自分のぶんだけ持つ。'
  '🚨 board_messages.outbox_hidden（1件に1つの印）は 2026-09-26 から使わない（列は残してある）。';

alter table public.board_outbox_hidden enable row level security;

drop policy if exists board_outbox_hidden_select_own on public.board_outbox_hidden;
create policy board_outbox_hidden_select_own on public.board_outbox_hidden
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists board_outbox_hidden_insert_own on public.board_outbox_hidden;
create policy board_outbox_hidden_insert_own on public.board_outbox_hidden
  for insert to authenticated
  with check (
    user_id = auth.uid()
    -- そのお知らせが自分に見えること（board_messages の select 権限がこの副問い合わせにも効く）
    and exists (
      select 1 from public.board_messages m
      where m.id = message_id and m.channel_id is null and m.parent_id is null
    )
  );

drop policy if exists board_outbox_hidden_delete_own on public.board_outbox_hidden;
create policy board_outbox_hidden_delete_own on public.board_outbox_hidden
  for delete to authenticated
  using (user_id = auth.uid());

-- 🚨 anon の権限を明示的に外す（自動で付くため）。更新は使わないので authenticated にも付けない。
--    authenticated も一度 all を外してから付け直す（既定の権限で all が付いており、取り消し版で update=true と実測した）
revoke all on table public.board_outbox_hidden from anon;
revoke all on table public.board_outbox_hidden from public;
revoke all on table public.board_outbox_hidden from authenticated;
grant select, insert, delete on table public.board_outbox_hidden to authenticated;
grant all on table public.board_outbox_hidden to service_role;

-- 既存の印を送信者本人のぶんとして写す（何度流しても増えない）
insert into public.board_outbox_hidden (message_id, user_id)
select id, user_id
  from public.board_messages
 where outbox_hidden = true and channel_id is null and parent_id is null
on conflict do nothing;

comment on column public.board_messages.outbox_hidden is
  '🚨 2026-09-26 から使わない。送信トレイのアーカイブは board_outbox_hidden（お知らせ × 人）に移した。'
  '列は戻すときの値として残してある。画面は読まない。';
