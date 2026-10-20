-- ============================================================
-- 2026-10-20  休職（段3の3：本人の使える機能・休職中の受理を断る）
-- 計画：docs/計画-休職と手続き.md
-- ============================================================
-- ・app_settings 'leave_feature_keys'：休職中に使える機能（権限管理の「休職中に使える機能」で変える）。
--   初めは 連絡板・FAQ・交通費・残業申請・勤務変更報告（計画の決定）。FAQ は faq と faq_nav（ナビにも出す）の2つで1つ
-- ・my_access_state：在籍者（mode=staff）で今日休職中なら leave = { return_date, keys } を足す。
--   keys＝基本（leave_feature_keys）＋この人だけ足す（features_add）−この人だけ引く（features_remove）。
--   🚨 mode は staff のまま（_shared/callerGate.ts は mode が staff と retiree_grace だけ通すため・レビュー指摘）
--   実際に使えるのは「keys にある」かつ「役職で使えていた」機能（画面の useAuth が両方を見る・退職者と同じ）
-- ・my_on_leave()：自分が今日休職中か（自分のことだけ）。RLS のポリシーで使う
-- ・休暇の受理（leave_requests の update_admin）：休職中は 1人目・2人目・社長として受理できない（本番の実定義に1つずつ足しただけ）
--   🚨 残業の受理（overtime-approve）・安否確認の送信（safety-check-send）・レシートの表示（receipt-signed-url）は Edge Function 側で断る
--   勤務変更の確認は is_approver()（段3の1で休職中は false）が見ているので直さない
--
-- ロールバック手順:
--   my_access_state を下の「元の定義」（この migration の前の本番）に戻す
--   update_admin を元の式に戻す（コメントに書いた）
--   drop function if exists my_on_leave(); delete from app_settings where key = 'leave_feature_keys';

insert into public.app_settings (key, value, updated_at)
values ('leave_feature_keys', '{"keys": ["board", "faq", "faq_nav", "expense", "overtime", "shift_report"]}'::jsonb, now())
on conflict (key) do nothing;

create or replace function public.my_on_leave()
returns boolean
language sql stable security definer set search_path to 'public'
as $$ select staff_on_leave(auth.uid()); $$;
revoke execute on function public.my_on_leave() from public, anon;
grant execute on function public.my_on_leave() to authenticated, retiree;

-- 元の定義（2026-10-20 本番）との違いは「if p.is_active then」の中だけ
CREATE OR REPLACE FUNCTION public.my_access_state()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  p record;
  v_keys jsonb;
  l record;
  v_base text[];
  v_leave_keys text[];
begin
  select pr.id, pr.is_active, pr.approval_status, pr.retire_date, pr.retiree_access_until,
         pr.hire_date, pr.retired_at
    into p
    from public.profiles pr
   where pr.id = auth.uid();

  if not found then
    return jsonb_build_object('mode', 'blocked');
  end if;

  if p.is_active then
    -- 休職中（2026-10-20）：mode は staff のまま、使える機能を添える
    if public.staff_on_leave(p.id) then
      select sl.return_date, sl.features_add, sl.features_remove into l
        from public.staff_leaves sl
       where sl.user_id = p.id and sl.ended_at is null and sl.cancelled_at is null
       order by sl.start_date desc limit 1;
      select coalesce(array(select jsonb_array_elements_text(s.value -> 'keys')), '{}') into v_base
        from public.app_settings s where s.key = 'leave_feature_keys';
      v_leave_keys := array(
        select distinct k from unnest(coalesce(v_base, '{}') || coalesce(l.features_add, '{}')) k
         where not (k = any (coalesce(l.features_remove, '{}'))));
      return jsonb_build_object('mode', 'staff',
        'leave', jsonb_build_object('return_date', l.return_date, 'keys', to_jsonb(v_leave_keys)));
    end if;
    return jsonb_build_object('mode', 'staff');
  end if;

  -- 🚨 承認待ちは退職者より先に判定する（取り違えるとログインさせてしまう）
  if coalesce(p.approval_status, '') = 'pending' then
    return jsonb_build_object('mode', 'blocked');
  end if;

  -- 入社予定（2026-10-04）。ログインはさせない（mode が staff でないので画面が追い出す）。入社日を返すだけ
  if p.hire_date is not null and p.retired_at is null and p.retire_date is null then
    return jsonb_build_object('mode', 'prehire', 'hire_date', p.hire_date);
  end if;

  if public.is_retiree_in_grace(p.id) then
    select coalesce(s.value -> 'keys', '[]'::jsonb) into v_keys
      from public.app_settings s where s.key = 'retiree_feature_keys';
    return jsonb_build_object(
      'mode',         'retiree_grace',
      'access_until', p.retiree_access_until,
      'retire_date',  p.retire_date,
      'feature_keys', coalesce(v_keys, '[]'::jsonb)
    );
  end if;

  return jsonb_build_object('mode', 'blocked');
exception when others then
  -- 🚨 ここで例外を投げると、画面が「立場が分からない」まま止まる。分からないときは blocked に倒す
  return jsonb_build_object('mode', 'blocked');
end;
$function$;

-- 休暇の受理：休職中は 1人目・2人目・社長として受理できない
-- 元：using ((approver_id = auth.uid()) OR (approver2_id = auth.uid()) OR is_admin() OR acts_as_is('president'))
--     with check (is_admin() OR acts_as_is('president') OR (((approver_id = auth.uid()) OR (approver2_id = auth.uid())) AND (user_id IS DISTINCT FROM auth.uid())))
drop policy if exists update_admin on public.leave_requests;
create policy update_admin on public.leave_requests
  for update to public
  using ((((approver_id = auth.uid()) OR (approver2_id = auth.uid())) AND NOT my_on_leave())
         OR is_admin()
         OR (acts_as_is('president'::text) AND NOT my_on_leave()))
  with check (is_admin()
         OR (acts_as_is('president'::text) AND NOT my_on_leave())
         OR (((approver_id = auth.uid()) OR (approver2_id = auth.uid())) AND (user_id IS DISTINCT FROM auth.uid()) AND NOT my_on_leave()));
