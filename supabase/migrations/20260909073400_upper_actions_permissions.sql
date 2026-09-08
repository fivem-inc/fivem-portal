-- ============================================================
-- 2026-09-09  上長が部下に対して行う操作を、管理画面から役職ごとに変えられるようにする
-- ============================================================
-- きっかけ：シフト調整の切替・申請の依頼・パートへの申請フォーム送信は、
-- どれも画面の中に役職名が直接書かれており、管理画面から変えられなかった。
-- 「ページは見られるが、この操作はできない」を作れるようにする（ユーザー確定）。
--
-- 🚨 直前の 20260909071455 で作った set_leave_shift_adjust は、役職名を直接見ていた。
--    このファイルで feature_permissions を見る形に作り直す（画面側と同じものを見る）。
--    適用済みのファイルは書き換えても流れ直さないので、必ず新しいファイルで直すこと。

-- ------------------------------------------------------------
-- 1) 権限の初期値
-- ------------------------------------------------------------
-- 🚨 既定は「いまと同じ動き」＝マネージャー・社長・管理者だけ ON。
--    ここで入れておかないと、画面側の既定が false なので誰も操作できなくなる。
--    リーダーに開放したくなったら管理画面でONにする。
insert into feature_permissions (role_id, feature_key, enabled)
select r.id, k.feature_key, (r.name in ('マネージャー', '社長', '管理者'))
  from roles r
  cross join (values
    ('leave_shift_adjust'),
    ('application_request'),
    ('part_leave_form_send')
  ) as k(feature_key)
on conflict (role_id, feature_key) do nothing;

-- 🚨 「パートへの申請フォーム送信」だけは、これまでリーダーも使えていた
--    （ページ内の判定が「リーダーは自分が送った分だけ見える」だった）。
--    いまの動きを変えないよう、リーダーも ON で始める。
update feature_permissions fp
   set enabled = true
  from roles r
 where r.id = fp.role_id
   and fp.feature_key = 'part_leave_form_send'
   and r.name = 'リーダー';

-- ------------------------------------------------------------
-- 2) シフト調整の RPC を「権限を見る」形に作り直す
-- ------------------------------------------------------------
-- 🚨 画面（useAuth の canLeaveShiftAdjust）と同じ feature_permissions を見る。
--    役職名を2か所に書くと、管理画面で変えたときに片方だけ古いままになる。
create or replace function set_leave_shift_adjust(p_id uuid, p_status text)
returns table (ok boolean, reason text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text;
  v_is_admin boolean;
  v_count int;
begin
  if p_status not in ('pending', 'adjusted', 'no_change') then
    return query select false, '状態の値が正しくありません'::text;
    return;
  end if;

  -- 🚨 管理者判定は必ず app_metadata->>'role'。'role' の直参照は常に false になる（過去に2回踏んでいる）
  -- 🚨🚨 coalesce を必ず付ける。app_metadata を持たない人（管理者以外はほぼ全員）だと
  --      この比較は false ではなく NULL になり、`NULL or false` は NULL、
  --      `if not NULL then` は成立しないため、役職チェックを素通りして更新まで進んでしまう。
  --      2026-09-09 の取り消しテストで、リーダー・一般・パートが全員変更できる状態だったのを発見した。
  v_is_admin := coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
  select role_title into v_role from profiles where id = auth.uid();

  -- 🚨 誰が変えられるかは管理画面「役職・機能権限」→ leave_shift_adjust で決める。
  --    役職名をここに書かない（序列の数値で「以上」を判定するのも禁止。
  --    並び順を変えたときにフロア責任者が自動的に入るため）。
  if not (v_is_admin or exists (
        select 1
          from feature_permissions fp
          join roles r on r.id = fp.role_id
         where fp.feature_key = 'leave_shift_adjust'
           and fp.enabled
           and r.name = coalesce(v_role, ''))) then
    return query select false, 'シフト調整の状態を変える権限がありません（管理画面の「役職・機能権限」で設定します）'::text;
    return;
  end if;

  -- 対象はマネージャー受理以降だけ（2026-09-09 ユーザー確定）。
  -- 🚨 有給は マネージャー受理 → 経理 → 社長 と受理が3段あるが、シフトを組むマネージャーが
  --    動けるのは1段目の時点なので、最終受理（approved）まで待たない。
  --    画面の出し分け・毎朝のお知らせの抽出条件も必ずこの3つに揃えること。
  update leave_requests
     set shift_adjust_status = p_status,
         shift_adjusted_at   = case when p_status = 'pending' then null else now() end,
         shift_adjusted_by   = case when p_status = 'pending' then null else auth.uid() end
   where id = p_id
     and status in ('manager_approved', 'admin_approved', 'approved');

  get diagnostics v_count = row_count;
  if v_count = 0 then
    return query select false, 'この休暇は受理前か、すでに取り消されています'::text;
    return;
  end if;

  return query select true, ''::text;
end $$;

-- 🚨 Supabase は新しい関数に anon の実行権限を自動で付ける。from public では外れないので
--    anon を明示して外す。適用後に必ず実測すること：
--    select has_function_privilege('anon','public.set_leave_shift_adjust(uuid,text)','execute');
revoke execute on function set_leave_shift_adjust(uuid, text) from public;
revoke execute on function set_leave_shift_adjust(uuid, text) from anon;
grant execute on function set_leave_shift_adjust(uuid, text) to authenticated;
