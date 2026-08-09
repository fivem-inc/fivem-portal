-- スタッフ情報（profiles）の更新権限を絞る（2026-08-10）
--
-- 🚨 これまでの状態が危険だった：
--   ・`leader_manager_update_leave_enabled` が using(true) with check(true)
--     ＝ ログインしていれば誰でも他人のプロフィールを書き換えられた（役職の変更も可能）
--   ・`ユーザーは自分のプロフィールを更新できる` は列を制限していないため、
--     本人が自分の role_title を '管理者' に書き換えられた
--   どちらも画面上はそんな操作をさせていないが、DBの許可としては開いていた。
--
-- RLSでは「この列だけ更新してよい」を表現できないため、
-- 必要な更新は SECURITY DEFINER の関数（RPC）に寄せ、直接のUPDATEは管理者だけに絞る。
--
-- 更新している箇所は事前に全部洗い出し済み（19箇所）：
--   管理者（管理画面）… 名前・役職・雇用形態・グループ・在籍状態・並び順・新規登録の承認
--     → 既存の「管理者は全操作できる」ポリシーで通る
--   リーダー以上 … 他人の休暇申請フォームを送る／取り消す（LeaveApprovals・管理画面）
--     → set_leave_request_enabled()
--   本人 … 申請完了時に自分のフォームを閉じる／ログイン時刻の記録
--     → clear_own_leave_request_enabled() / touch_last_sign_in()

-- ────────────────────────────────
-- ① 危険なUPDATEポリシーを外す
-- ────────────────────────────────
drop policy if exists "leader_manager_update_leave_enabled" on public.profiles;
drop policy if exists "ユーザーは自分のプロフィールを更新できる" on public.profiles;

-- ────────────────────────────────
-- ② リーダー以上：他人に休暇申請フォームを送る／取り消す
-- ────────────────────────────────
create or replace function public.set_leave_request_enabled(p_user_id uuid, p_enabled boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not (
    (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    or exists (
      select 1 from profiles
      where id = auth.uid()
        and role_title = any (array['リーダー', 'マネージャー', '社長', '管理者'])
    )
  ) then
    raise exception '休暇申請フォームを送る権限がありません';
  end if;

  update profiles
     set leave_request_enabled = p_enabled,
         leave_enabled_by = case when p_enabled then auth.uid() else null end
   where id = p_user_id;
end $$;

-- ────────────────────────────────
-- ③ 本人：申請を送り終えたら自分のフォームを閉じる
-- ────────────────────────────────
create or replace function public.clear_own_leave_request_enabled()
returns void language plpgsql security definer set search_path = public as $$
begin
  update profiles
     set leave_request_enabled = false, leave_enabled_by = null
   where id = auth.uid();
end $$;

-- ────────────────────────────────
-- ④ 本人：最終アクセス日時の記録
-- ────────────────────────────────
create or replace function public.touch_last_sign_in()
returns void language plpgsql security definer set search_path = public as $$
begin
  update profiles set last_sign_in_at = now() where id = auth.uid();
end $$;

revoke all on function public.set_leave_request_enabled(uuid, boolean) from public;
revoke all on function public.clear_own_leave_request_enabled() from public;
revoke all on function public.touch_last_sign_in() from public;
grant execute on function public.set_leave_request_enabled(uuid, boolean) to authenticated;
grant execute on function public.clear_own_leave_request_enabled() to authenticated;
grant execute on function public.touch_last_sign_in() to authenticated;
