-- ============================================================
-- 2026-09-09  申請系のまとめ直し（回B）
--   ② 「内容を修正する（取り消して再申請）」の紐づけ
--   ⑧ 休暇の「シフト調整」の状態（未／調整済／確認済（変更なし））
--   ⑨ シフト未調整の休暇を上長に知らせるための印と通知設定
-- ============================================================
-- 🚨 適用の順番：このファイル → push-dispatch の deploy → 新 Edge Function の deploy → クライアント push
--    逆にすると、まだ無い列を読みに行って画面が壊れる。

-- ------------------------------------------------------------
-- ② 修正の紐づけ（受理者に「修正の再申請」と分かるようにする）
-- ------------------------------------------------------------
-- 「内容を修正する（取り消して再申請）」は、元の申請を取り消して新しい申請を作る。
-- これまで両者に関係が無く、受理者からは「ただの新しい申請」にしか見えなかった。
-- どの申請を直したものかを持たせ、受理の画面で「🔁 修正」と修正前の内容を出せるようにする。
alter table overtime_reports
  add column if not exists modified_from_id uuid references overtime_reports(id) on delete set null;

comment on column overtime_reports.modified_from_id is
  '「内容を修正する（取り消して再申請）」で作り直したときの、元（取消済み）の申請ID。受理者に修正前の内容を見せるために持つ。元が消えたら null になる';

create index if not exists idx_overtime_modified_from
  on overtime_reports(modified_from_id) where modified_from_id is not null;

-- ------------------------------------------------------------
-- ⑧ 休暇のシフト調整の状態
-- ------------------------------------------------------------
-- 休暇が受理されたあと、その人の抜けたシフトを組み直せたかどうかを記録する。
-- 3つの状態を使い分ける（2026-09-09 ユーザー確定）：
--   pending   … 未（まだ何もしていない）
--   adjusted  … 調整済（シフトを組み直した）
--   no_change … 確認済（変更なし）＝調整したうえで、いまのスタッフのままでいくと決めた
-- 🚨 no_change は「まだ触っていない」ではなく「見たうえで決めた」。pending と必ず区別すること。
alter table leave_requests
  add column if not exists shift_adjust_status text not null default 'pending',
  add column if not exists shift_adjusted_at timestamptz,
  add column if not exists shift_adjusted_by uuid references auth.users(id) on delete set null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'leave_requests_shift_adjust_status_check'
      and conrelid = 'public.leave_requests'::regclass
  ) then
    alter table leave_requests
      add constraint leave_requests_shift_adjust_status_check
      check (shift_adjust_status in ('pending', 'adjusted', 'no_change'));
  end if;
end $$;

comment on column leave_requests.shift_adjust_status is
  'シフト調整の状態。pending=未／adjusted=調整済／no_change=確認済（変更なし・現スタッフのままでいく）';
comment on column leave_requests.shift_adjusted_by is
  'シフト調整の状態を最後に変えた人。取消のときに「誰に戻してもらうか」を知るために持つ';

-- 未調整のものを毎朝の cron が探すための索引（受理済みだけを見る）
create index if not exists idx_leave_shift_adjust_pending
  on leave_requests(shift_adjust_status, start_date)
  where shift_adjust_status = 'pending';

-- ------------------------------------------------------------
-- ⑧ 状態を変える RPC
-- ------------------------------------------------------------
-- 🚨 画面から直接 update しない。本番の update ポリシー（update_admin）は
--    「リーダー以上なら、どの行のどの列でも書ける」という緩いもので（with_check が無い）、
--    画面側で役職を絞っても DB は止めない。列と役職を限定したこの関数だけを通す。
--    （2026-09-09 に本番の pg_policies を読み取りで実測して確認）
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
  --      この比較は false ではなく **NULL** になり、`NULL or false` は NULL、
  --      `if not NULL then` は成立しないため、役職チェックを素通りして更新まで進んでしまう。
  --      2026-09-09 の取り消しテストで、リーダー・一般・パートが全員変更できる状態だったのを発見した。
  v_is_admin := coalesce((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin', false);
  select role_title into v_role from profiles where id = auth.uid();

  -- 🚨 誰が変えられるかは、役職名をここに書かず、管理画面「役職・機能権限」の
  --    leave_shift_adjust を見る（2026-09-09 ユーザー確定）。画面側（useAuth の
  --    canLeaveShiftAdjust）と同じものを見ているので、管理画面で変えれば両方に効く。
  --    🚨 役職の序列の数値で「以上」を判定しない（並び順を変えるとフロア責任者が自動で入る）。
  -- 🚨 v_role も NULL になり得る（profiles に行が無い・役職が空）ので coalesce で落とす
  if not (v_is_admin or exists (
        select 1
          from feature_permissions fp
          join roles r on r.id = fp.role_id
         where fp.feature_key = 'leave_shift_adjust'
           and fp.enabled
           and r.name = coalesce(v_role, ''))) then
    return query select false, 'シフト調整の状態を変えられるのは、マネージャー以上の方だけです'::text;
    return;
  end if;

  -- 対象はマネージャー受理以降だけ（2026-09-09 ユーザー確定）。
  -- 🚨 有給は マネージャー受理 → 経理 → 社長 と受理が3段あるが、シフトを組むマネージャーが
  --    動けるのは1段目の時点なので、最終受理（approved）まで待たない。
  --    画面の出し分け・⑨の抽出条件も必ずこの3つに揃えること。
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
--    anon を明示して外す（2026-09-05 にこれで踏んでいる）。適用後に実測すること：
--    select has_function_privilege('anon','public.set_leave_shift_adjust(uuid,text)','execute');
revoke execute on function set_leave_shift_adjust(uuid, text) from public;
revoke execute on function set_leave_shift_adjust(uuid, text) from anon;
grant execute on function set_leave_shift_adjust(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- ⑨ シフト未調整の休暇を知らせるための印
-- ------------------------------------------------------------
-- 🚨 「休暇日の3ヶ月前ちょうど」を等号で判定すると、cron が1日止まった日の分が
--    永遠に送られない。「その日以内に入った かつ まだ送っていない」で判定するため、
--    送った印を列に残す（別表にすると掃除が要るので列で持つ）。
alter table leave_requests
  add column if not exists shift_alert_3m_sent_at timestamptz,
  add column if not exists shift_alert_1m_sent_at timestamptz;

comment on column leave_requests.shift_alert_3m_sent_at is
  'シフト未調整のお知らせ（3ヶ月前）を送った日時。二重送信を防ぐための印';
comment on column leave_requests.shift_alert_1m_sent_at is
  'シフト未調整のお知らせ（1ヶ月前）を送った日時。二重送信を防ぐための印';

-- ------------------------------------------------------------
-- ⑨ 通知の宛先を解決する関数（役職＋所属チーム）
-- ------------------------------------------------------------
-- 🚨 同じ解決処理が、すでに3か所にある：
--      client/src/lib/notificationDispatch.ts  resolveRoleRecipients
--      supabase/functions/leave-approved-notify/index.ts  resolveTargetIds
--      supabase/functions/remind-overtime-threshold/index.ts
--    4か所目を書き写すのを避けるため、ここに1本置いて新しい Edge Function はこれを呼ぶ。
--    上の3か所の置き換えは別件（今回は触らない）。
--
-- 🚨 group_names には所属チーム（こども／大人／管理部）と配信用グループ（正社員・契約社員 等）が
--    混ざっている。そのまま突き合わせると管理職は全員「正社員」を持つため、
--    「同グループのみ」が実質「全員」になる（2026-08-04 に Edge Function 4本で踏んだ不具合）。
--    必ず master_options の shift_report_group と照合して、所属チームだけを取り出す。
create or replace function resolve_role_recipients(
  p_applicant uuid,
  p_recipient jsonb
)
returns setof uuid
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_roles       text[];
  v_group_filter text;
  v_org_wide    text[];
  v_group_roles text[];
  v_owide_roles text[];
  v_teams       text[];
begin
  -- 既定は leave-approved-notify と同じ（設定が無いときの動き）
  v_roles        := coalesce(
                      (select array_agg(x) from jsonb_array_elements_text(p_recipient -> 'roles') x),
                      array['リーダー', 'マネージャー', '社長']);
  v_group_filter := coalesce(p_recipient ->> 'groupFilter', 'all');
  v_org_wide     := coalesce(
                      (select array_agg(x) from jsonb_array_elements_text(p_recipient -> 'orgWideRoles') x),
                      array['社長', '管理者']);

  -- 「申請者本人」は宛先の指定として使われるが、ここでは役職として引かない
  v_roles := array(select unnest(v_roles) except select '申請者本人');

  v_group_roles := array(select unnest(v_roles) except select unnest(v_org_wide));
  v_owide_roles := array(select unnest(v_roles) intersect select unnest(v_org_wide));

  -- 申請者の所属チーム（配信用グループを除く）
  select coalesce(array_agg(g), '{}')
    into v_teams
    from unnest(coalesce((select group_names from profiles where id = p_applicant), '{}')) g
   where g in (select value from master_options where category = 'shift_report_group');

  -- 🚨 マスタが1件も取れないときは絞り込みを諦めて全グループで判定する
  --    （誰にも届かないより安全側。既存3か所と同じ考え方）
  if not exists (select 1 from master_options where category = 'shift_report_group') then
    v_teams := coalesce((select group_names from profiles where id = p_applicant), '{}');
  end if;

  return query
    select p.id from profiles p
     where p.is_active = true
       and p.role_title = any(v_group_roles)
       and (v_group_filter <> 'same' or cardinality(v_teams) = 0 or p.group_names && v_teams)
       and p.id <> p_applicant
    union
    select p.id from profiles p
     where p.is_active = true
       and p.role_title = any(v_owide_roles)
       and p.id <> p_applicant;
end $$;

revoke execute on function resolve_role_recipients(uuid, jsonb) from public;
revoke execute on function resolve_role_recipients(uuid, jsonb) from anon;

-- ------------------------------------------------------------
-- ⑨ 通知設定（新しい種類は必ず宛先ごと登録する）
-- ------------------------------------------------------------
-- 🚨 設定行が無いイベントは push-dispatch が「ON扱い」で処理し、
--    宛先の指定も無いと全員に飛ぶ。46人にいきなり届くのを防ぐため、
--    ここで宛先（同じチームのマネージャー以上）まで含めて必ず入れる。
insert into notification_settings (event_key, channel, enabled, recipient, subject, template) values
  ('leave:shift_adjust_due', 'site', true,
   '{"roles":["マネージャー","社長"],"groupFilter":"same","orgWideRoles":["社長","管理者"]}', null, null),
  ('leave:shift_adjust_due', 'push', true,
   '{"roles":["マネージャー","社長"],"groupFilter":"same","orgWideRoles":["社長","管理者"]}', null, null),
  ('leave:shift_adjust_due', 'email', false, null, 'シフト調整がまだの休暇があります',
   E'受理済みの休暇のうち、シフト調整がまだのものが {{件数}} 件あります。\n{{内訳}}\n\n下記から確認してください。\n{{リンク}}')
on conflict (event_key, channel) do nothing;
