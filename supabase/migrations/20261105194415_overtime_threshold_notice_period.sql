-- ============================================================
-- 2026-11-05  残業の目安超え（申請のたびの即時のお知らせ）の文に、給与期間と「見込み」を入れる（ユーザー確定 案1）
-- ============================================================
-- きっかけ：今の期間（10/16〜11/15）が −3:00 の方に、次の期間（11/16〜12/15）の振替休日の見込み（＋4:30）で「今月の残業が3時間を超えました」が届き、今の期間の話に見えた
-- 例：「12月給与分（11/16〜12/15）の残業が、見込みで3時間を超えました」
-- 🚨 本番の実定義（pg_get_functiondef・2026-11-05 取得）から起こした。変えたのは message の1か所だけ

CREATE OR REPLACE FUNCTION public.notify_overtime_threshold_exceeded()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_user     uuid;
  v_period   date;
  v_total    integer;
  v_threshold integer;
  v_on       boolean;
  v_name     text;
begin
  v_user   := coalesce(new.applicant_id, old.applicant_id);
  v_period := coalesce(new.pay_period_start, old.pay_period_start);
  if v_user is null or v_period is null then return coalesce(new, old); end if;

  select notify_on_exceed into v_on from overtime_settings where id = 1;
  if not coalesce(v_on, true) then return coalesce(new, old); end if;

  v_threshold := overtime_threshold_for(v_user);
  if v_threshold is null then return coalesce(new, old); end if;  -- 除外されている人

  select planned_total into v_total from overtime_planned_totals(v_period) where user_id = v_user;
  if coalesce(v_total, 0) <= v_threshold then return coalesce(new, old); end if;

  -- 期に1回だけ。しきい値が下がった場合は前回より低い値なので再通知したいが、
  -- ここでは単純に「その期に1回」とする（指定日の通知が拾うため）
  insert into overtime_threshold_notifications
    (user_id, pay_period_start, kind, notify_key, total_minutes, threshold_minutes)
  values (v_user, v_period, 'exceed', 'exceed', v_total, v_threshold)
  on conflict (user_id, pay_period_start, kind, notify_key) do nothing;

  if not found then return coalesce(new, old); end if;

  select name into v_name from profiles where id = v_user;

  -- ベル通知。event_key を入れると push_queue に積まれ push-dispatch が拾う。
  -- ⚠️ 本文に「リマインド」「お知らせ」「メッセージが届き」を入れないこと
  --    （App.tsx の連絡板判定が先に効いてタップで /board に飛ぶ）
  insert into notifications (user_id, message, sub_message, source_type, event_key, reference_id)
  values (
    v_user,
    -- 🚨 2026-11-05：どの給与期間か・見込みかを書く（ユーザー確定 案1）。前は「今月の残業が…」で、今の期間がマイナスでも次の期間の見込みで届いて紛らわしかった
    extract(month from (v_period + interval '1 month'))::int::text || '月給与分（'
      || extract(month from v_period)::int::text || '/16〜' || extract(month from (v_period + interval '1 month'))::int::text || '/15）の残業が、見込みで'
      || (v_threshold / 60)::text || '時間を超えました',
    '時間調整をお願いします',
    'overtime:threshold',
    'overtime:threshold',
    v_period::text
  );

  return coalesce(new, old);
exception when others then
  -- 通知に失敗しても残業の登録そのものは通す
  return coalesce(new, old);
end;
$function$;
