-- 退職者の申請期間・2段目の手順4（2026-09-20・設計書 §8-3 / §8-5）
-- 退職の確定時に「管理者の権限を外す」「ログイン中の画面を止める」、
-- 申請期間が過ぎたら「ログインを止める」「プッシュの登録を消す」。
-- 🚨 関数は本番の実定義（pg_get_functiondef）から起こしている。足したところ以外は1文字も変えていない。
-- 🚨 いま退職日が入っている人は0人（2026-09-20 実測）なので、適用しても誰にも何も起きない。

-- ───────────────────────────────────────────────
-- 0. 退職のときに外した権限の控え（復活のときに戻すため）
--    🚨 外部キーは付けない（2026-09-19 の障害と同型になるため。ただの文字の列）
-- ───────────────────────────────────────────────
alter table public.profiles add column if not exists retired_app_role text;
comment on column public.profiles.retired_app_role is
  '退職の確定時に auth.users の app_metadata から外した role（例 admin）の控え。復活で戻して空にする';

-- ───────────────────────────────────────────────
-- 1. retire_apply：退職に切り替えた直後に、権限を外してセッションを消す
-- ───────────────────────────────────────────────
create or replace function public.retire_apply(p_user uuid)
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  v_admin uuid;
  v_n integer := 0;
  v_c integer;
  v_app_role text;
begin
  -- 在籍中で、退職日が入っていて、承認待ちではない人だけ
  update profiles p
     set is_active = false,
         retired_at = now(),
         retired_role_id = p.role_id,
         retired_employment_type = p.employment_type,
         retiree_access_until = coalesce(p.retiree_access_until, retire_access_default(p.retire_date))
   where p.id = p_user
     and p.is_active = true
     and p.retire_date is not null
     and coalesce(p.approval_status, '') <> 'pending';
  if not found then return 0; end if;

  -- 🚨 ここからの2つは、付け替え先の管理者が見つからなくても必ず行う（下の return 0 より前に置くこと）
  -- ① 管理者の権限を外す（ログインの鍵に入る app_metadata.role を消す）。復活で戻せるよう控えを残す
  select u.raw_app_meta_data ->> 'role' into v_app_role from auth.users u where u.id = p_user;
  if v_app_role is not null then
    update profiles set retired_app_role = v_app_role where id = p_user;
    update auth.users set raw_app_meta_data = raw_app_meta_data - 'role' where id = p_user;
  end if;
  -- ② いま開いている画面を止める（セッションを消す。更新用の鍵は連動して消える）
  delete from auth.sessions where user_id = p_user;

  -- 付け替え先＝「管理者」アカウント（app_metadata.role='admin' かつ在籍・本人以外）。
  -- 🚨 2026-09-18 時点で1つだけ。複数あれば最も古いもの。無ければ付け替えない（記録も残さない）
  select u.id into v_admin
    from auth.users u join profiles pr on pr.id = u.id
   where u.raw_app_meta_data->>'role' = 'admin' and pr.is_active = true and u.id <> p_user
   order by u.created_at
   limit 1;
  if v_admin is null then return 0; end if;

  -- 残業：確定・取り消し以外は、まだ確認者が関わる
  with t as (
    update overtime_reports set reviewer_id = v_admin
     where reviewer_id = p_user and status not in ('confirmed', 'cancelled')
    returning id)
  insert into retire_reassignments (retired_user_id, table_name, row_id, column_name, to_user_id)
  select p_user, 'overtime_reports', id, 'reviewer_id', v_admin from t;
  get diagnostics v_c = row_count; v_n := v_n + v_c;

  -- 勤務変更報告：確認待ち
  with t as (
    update shift_reports set reviewer_id = v_admin
     where reviewer_id = p_user and status = 'pending'
    returning id)
  insert into retire_reassignments (retired_user_id, table_name, row_id, column_name, to_user_id)
  select p_user, 'shift_reports', id, 'reviewer_id', v_admin from t;
  get diagnostics v_c = row_count; v_n := v_n + v_c;

  -- 休暇：1人目・2人目の承認者（受理前）
  with t as (
    -- 🚨 1人目は「まだ受理していない」行だけ（manager_approved は1人目がもう受理済み＝受理した人の記録を書き換えない・2026-09-19 レビュー）
    update leave_requests set approver_id = v_admin
     where approver_id = p_user and status = 'pending'
    returning id)
  insert into retire_reassignments (retired_user_id, table_name, row_id, column_name, to_user_id)
  select p_user, 'leave_requests', id, 'approver_id', v_admin from t;
  get diagnostics v_c = row_count; v_n := v_n + v_c;

  with t as (
    update leave_requests set approver2_id = v_admin
     where approver2_id = p_user and status in ('pending', 'manager_approved')
    returning id)
  insert into retire_reassignments (retired_user_id, table_name, row_id, column_name, to_user_id)
  select p_user, 'leave_requests', id, 'approver2_id', v_admin from t;
  get diagnostics v_c = row_count; v_n := v_n + v_c;

  -- 🚨 備品購入申請（承認者が複数・承認済みの人と未承認の人が混ざる）は自動では付け替えない。
  --    チェック表に「未処理の申請」として出し、既存の［承認者を変更］で直す（2026-09-19）
  return v_n;
end;
$fn$;

-- ───────────────────────────────────────────────
-- 2. retire_daily：期限が過ぎた退職者のログインを止める＋プッシュの登録を消す
-- ───────────────────────────────────────────────
create or replace function public.retire_daily()
 returns integer
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare
  r record;
  v_count integer := 0;
begin
  -- (1) 退職日を過ぎた人を退職に切り替える
  for r in
    select id from profiles
     where is_active = true
       and retire_date is not null
       and retire_date < (now() at time zone 'Asia/Tokyo')::date
       and coalesce(approval_status, '') <> 'pending'
  loop
    -- 🚨 1人ずつ失敗を受け止める（2026-09-19 レビュー）。受け止めないと、付け替え先の申請のトリガー
    --    （enforce_furikae_no_double_count など）が1件でも例外を出すと、その夜の全員ぶんが取り消される。
    --    失敗した人は在籍のまま残るので、チェック表に「自動の切り替えに失敗しています」と出る（退職日 < 今日 かつ 在籍）
    begin
      perform retire_apply(r.id);
      v_count := v_count + 1;
    exception when others then
      raise warning '[retire_daily] % の退職の切り替えに失敗しました: %', r.id, sqlerrm;
    end;
  end loop;

  -- (2) 申請期間（retiree_access_until）が過ぎた退職者：ログインを止める＋プッシュの登録を消す
  --     🚨 すでに止めてある人は対象にしない（毎晩あたらしく止め直さない）
  --     🚨 ここも1人ずつ受け止める（1人の失敗で (1) の結果まで取り消さない）
  for r in
    select p.id
      from profiles p
      join auth.users u on u.id = p.id
     where p.is_active = false
       and p.retired_at is not null
       and p.retiree_access_until is not null
       and p.retiree_access_until < (now() at time zone 'Asia/Tokyo')::date
       and (u.banned_until is null or u.banned_until < now())
  loop
    begin
      update auth.users set banned_until = now() + interval '100 years' where id = r.id;
      delete from auth.sessions where user_id = r.id;
      delete from push_subscriptions where user_id = r.id;
    exception when others then
      raise warning '[retire_daily] % の期限切れの処理に失敗しました: %', r.id, sqlerrm;
    end;
  end loop;

  return v_count;
end;
$fn$;

-- ───────────────────────────────────────────────
-- 3. retire_restore：復活のときにログインの停止を解き、外した権限を戻す
-- ───────────────────────────────────────────────
create or replace function public.retire_restore(p_user uuid)
 returns void
 language plpgsql
 security definer
 set search_path to 'public'
as $fn$
declare v_app_role text;
begin
  if not is_admin() then raise exception '管理者だけが操作できます' using errcode = '42501'; end if;
  select retired_app_role into v_app_role from profiles where id = p_user;
  update profiles
     set is_active = true,
         retire_date = null,
         retiree_access_until = null,
         retired_at = null,
         retired_role_id = null,
         retired_employment_type = null,
         retired_app_role = null
   where id = p_user
     and is_active = false
     and coalesce(approval_status, '') <> 'pending';
  if not found then raise exception '退職済みの人だけ復活できます（承認待ちの人は対象外）'; end if;
  delete from retire_checklist_checks where user_id = p_user;
  -- ログインの停止を解く＋退職のときに外した権限（管理者など）を戻す
  update auth.users
     set banned_until = null,
         raw_app_meta_data = case
           when v_app_role is null then raw_app_meta_data
           else jsonb_set(coalesce(raw_app_meta_data, '{}'::jsonb), '{role}', to_jsonb(v_app_role))
         end
   where id = p_user;
  -- 付け替えの記録（retire_reassignments）は残す：誰の退職で移したかの履歴のため
end;
$fn$;

-- 戻し版（この migration を取り消すとき）:
--   2026-09-19 適用時点の retire_apply / retire_daily / retire_restore に create or replace で戻し、
--   alter table public.profiles drop column retired_app_role;
