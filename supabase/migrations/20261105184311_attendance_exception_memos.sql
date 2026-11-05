-- ============================================================
-- 2026-11-05  勤怠カレンダーの備考を「ご本人に見せる」と「上長だけ」に分ける（ユーザー確定 案1）
-- ============================================================
-- きっかけ：attendance_exceptions.notes（備考・1つの欄）に「◯◯先生 調整休のため」など、ほかの方の休みの理由が書かれ、
--   勤務変更の画面の「予定の備考」としてパートご本人に見えていた。
-- 🚨 ご本人は自分の行を全部の列ごと読める（RLS「Users can view own attendance_exceptions」）ので、同じ表の列では隠せない。
--   上長だけのメモは別の表に置き、読めるのは勤怠カレンダーを入力できる方（attendance_input）と管理者だけにする。
-- ・notes は「スタッフへの連絡（ご本人に表示されます）」として残す
-- ・今ある備考のうち、ご本人以外が書いたもの（created_by <> user_id）は全部「上長だけのメモ」へ移し、notes を空にする（迷ったら上長だけ・ユーザー確定）
--   ご本人が自分で書いたもの（時間調整など）は notes のまま
-- ・予定を消すとメモも消える（on delete cascade）
-- 🚨 新しい表なので GRANT を同じファイルに書く（2026-10-30 からの Supabase の変更）

begin;

create table if not exists public.attendance_exception_memos (
  exception_id uuid primary key references public.attendance_exceptions(id) on delete cascade,
  memo        text not null check (length(btrim(memo)) between 1 and 500),
  created_by  uuid references auth.users(id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
comment on table public.attendance_exception_memos is
  '勤怠カレンダーの予定の「上長だけのメモ」（スタッフには表示されない）。読み書きは attendance_input の方と管理者だけ。ご本人に見せる文は attendance_exceptions.notes';

alter table public.attendance_exception_memos enable row level security;

drop policy if exists attendance_exception_memos_manage on public.attendance_exception_memos;
create policy attendance_exception_memos_manage on public.attendance_exception_memos
  for all to authenticated
  using (is_admin() or has_feature_permission('attendance_input'))
  with check (is_admin() or has_feature_permission('attendance_input'));

revoke all on public.attendance_exception_memos from anon;
revoke all on public.attendance_exception_memos from public;
grant select, insert, update, delete on public.attendance_exception_memos to authenticated;
grant all on public.attendance_exception_memos to service_role;

-- 今ある備考の移し替え（ご本人以外が書いたもの）
insert into public.attendance_exception_memos (exception_id, memo, created_by, created_at, updated_at)
select a.id, btrim(a.notes), a.created_by, a.created_at, now()
  from public.attendance_exceptions a
 where coalesce(btrim(a.notes), '') <> ''
   and a.created_by is distinct from a.user_id
on conflict (exception_id) do nothing;

update public.attendance_exceptions a
   set notes = null
 where coalesce(btrim(a.notes), '') <> ''
   and a.created_by is distinct from a.user_id
   and exists (select 1 from public.attendance_exception_memos m where m.exception_id = a.id);

commit;
