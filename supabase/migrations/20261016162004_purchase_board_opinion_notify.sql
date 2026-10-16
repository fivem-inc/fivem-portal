-- 備品の全員承認：1件ごとのお知らせ・回答した日時（2026-10-16 ユーザー確定）
-- ・申請者へ、回答が1件入るたびに（承認・否認・判断できない・その他すべて）ベル＋スマホ。
--   名前を見てよい申請者（マネージャー以上など・purchase_request_approval_progress の can_see_names と同じ考え方）には名前つき
--   （board_opinion_to_applicant）、それ以外は名前なし（board_opinion_to_applicant_anon）。全員そろったときは今までどおり board_all_approved の1通だけ
-- ・ほかの承認者へのお知らせ（board_opinion_submitted）は、まだ回答していない人にだけ（画面側）。スマホの行を同じ event_key に足して、通知設定で一緒に変えられるように
-- ・purchase_request_approval_progress：answers に answered_at（回答した日時・直したら直した日時）を足すだけ。本番の実定義から起こした

begin;

insert into public.notification_settings (event_key, channel, enabled, recipient, template)
select v.event_key, v.channel, true, v.recipient, v.template
  from (values
    ('purchase_request:board_opinion_to_applicant', 'site', '{"recipients":["applicant"]}', '🧾 「{{品目名}}」の申請を{{回答者名}}さんが{{回答}}'),
    ('purchase_request:board_opinion_to_applicant', 'push', null, null),
    ('purchase_request:board_opinion_to_applicant_anon', 'site', '{"recipients":["applicant"]}', '🧾 「{{品目名}}」の申請に回答が1件ありました（{{回答}}）'),
    ('purchase_request:board_opinion_to_applicant_anon', 'push', null, null),
    ('purchase_request:board_opinion_submitted', 'push', null, null)
  ) as v(event_key, channel, recipient, template)
 where not exists (select 1 from public.notification_settings s where s.event_key = v.event_key and s.channel = v.channel);

CREATE OR REPLACE FUNCTION public.purchase_request_approval_progress(p_ids uuid[])
 RETURNS TABLE(purchase_request_id uuid, answered integer, required integer, pending_ids uuid[], answers jsonb)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  WITH me AS (
    SELECT
      auth.uid() AS uid,
      ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin') AS is_admin,
      role_is_board_approver(auth.uid()) AS is_board
  )
  SELECT
    r.id,
    ans.cnt,
    COALESCE(array_length(a.ids, 1), 0)::integer,
    CASE WHEN vis.can_see_names THEN pend.ids ELSE '{}'::uuid[] END,
    CASE WHEN vis.can_see_names THEN ans.detail ELSE '[]'::jsonb END
  FROM purchase_requests r
  CROSS JOIN me
  CROSS JOIN LATERAL (
    SELECT COALESCE(r.board_approver_ids, r.requested_manager_ids) AS ids
  ) a
  CROSS JOIN LATERAL (
    SELECT
      count(*)::integer AS cnt,
      COALESCE(
        jsonb_agg(jsonb_build_object('manager_id', o.manager_id, 'opinion', o.opinion, 'answered_at', coalesce(o.updated_at, o.created_at)) ORDER BY o.created_at),
        '[]'::jsonb
      ) AS detail
    FROM purchase_request_manager_opinions o
    WHERE o.purchase_request_id = r.id
      AND o.approval_round = r.approval_round
  ) ans
  CROSS JOIN LATERAL (
    SELECT COALESCE(array_agg(x), '{}'::uuid[]) AS ids
    FROM unnest(COALESCE(a.ids, '{}'::uuid[])) AS x
    WHERE NOT EXISTS (
      SELECT 1
      FROM purchase_request_manager_opinions o
      WHERE o.purchase_request_id = r.id
        AND o.approval_round = r.approval_round
        AND o.manager_id = x
    )
  ) pend
  CROSS JOIN LATERAL (
    SELECT (
      me.is_admin
      OR me.is_board
      OR me.uid = ANY(COALESCE(r.board_approver_ids, '{}'::uuid[]))
      OR me.uid = ANY(COALESCE(r.requested_manager_ids, '{}'::uuid[]))
    ) AS can_see_names
  ) vis
  WHERE r.id = ANY(p_ids)
    AND (
      r.user_id = me.uid
      OR me.uid = ANY(COALESCE(r.board_approver_ids, '{}'::uuid[]))
      OR me.uid = ANY(COALESCE(r.requested_manager_ids, '{}'::uuid[]))
      OR me.is_board
      OR me.is_admin
    );
$function$;

revoke execute on function public.purchase_request_approval_progress(uuid[]) from public;
revoke execute on function public.purchase_request_approval_progress(uuid[]) from anon;
grant execute on function public.purchase_request_approval_progress(uuid[]) to authenticated;

commit;
