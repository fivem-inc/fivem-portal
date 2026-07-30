-- 備品購入申請：マネージャー以上は、どの申請でも「承認の進み具合」と「意見」を見られるようにする
--
-- 【背景】履歴に進み具合が出ていなかった
--   ・クライアントが「自分が出した申請」だけ進捗を取りに行っていた（→そちらは修正済み）
--   ・DB側も、進捗を返す相手が「申請者・その申請の承認者・管理者」に限られていた
--   そのため、承認者でない申請（1万円超〜3万円でほかのマネージャーに依頼されたもの等）は
--   マネージャーが見ても何も出なかった。
--
--   実機で「マネージャーは常にすべて見れないと判断できない。過去の申請も記憶していない」と指摘。
--   購入申請そのものはマネージャー以上に全件見えている（pr_manager_plus_select）ので、
--   進み具合と意見も同じ範囲に揃える。
--
--   ⚠️ リーダー以下には広げない。申請者がリーダー以下のときに「件数だけ」に絞る方針は維持する
--      （2026-07-30に決めた出し分け）。

-- ========================================
-- 1. 意見の閲覧：マネージャー以上はどの申請でも全件見える
-- ========================================
DROP POLICY "opinion_select" ON public.purchase_request_manager_opinions;
CREATE POLICY "opinion_select" ON public.purchase_request_manager_opinions
  FOR SELECT USING (
    -- その申請の承認を依頼された人
    EXISTS (
      SELECT 1 FROM public.purchase_requests pr
      WHERE pr.id = purchase_request_id
        AND (auth.uid() = ANY(pr.requested_manager_ids) OR auth.uid() = ANY(pr.board_approver_ids))
    )
    -- マネージャー以上（申請者であるかどうかに関係なく、判断のために全件見える）
    OR EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role_title IN ('マネージャー', '社長')
    )
    -- それ以外の申請者は、回答者が共有を選んだものだけ
    OR (
      visible_to_applicant
      AND EXISTS (
        SELECT 1 FROM public.purchase_requests pr
        WHERE pr.id = purchase_request_id AND pr.user_id = auth.uid()
      )
    )
  );

-- ========================================
-- 2. 承認の進み具合：マネージャー以上はどの申請でも名前つきで見える
-- ========================================
DROP FUNCTION IF EXISTS public.purchase_request_approval_progress(uuid[]);

CREATE FUNCTION public.purchase_request_approval_progress(p_ids uuid[])
RETURNS TABLE (
  purchase_request_id uuid,
  answered integer,
  required integer,
  pending_ids uuid[],
  answers jsonb
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH me AS (
    SELECT
      auth.uid() AS uid,
      ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin') AS is_admin,
      (SELECT p.role_title FROM profiles p WHERE p.id = auth.uid()) AS role_title
  )
  SELECT
    r.id,
    ans.cnt,
    COALESCE(array_length(a.ids, 1), 0)::integer,
    -- 名前を見せてよい相手にだけ返す。それ以外は空配列（件数だけで表示させる）
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
        jsonb_agg(jsonb_build_object('manager_id', o.manager_id, 'opinion', o.opinion) ORDER BY o.created_at),
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
      -- マネージャー以上は、申請者・承認者であるかどうかに関係なく名前つきで見える
      OR me.role_title IN ('マネージャー', '社長')
      OR me.uid = ANY(COALESCE(r.board_approver_ids, '{}'::uuid[]))
      OR me.uid = ANY(COALESCE(r.requested_manager_ids, '{}'::uuid[]))
    ) AS can_see_names
  ) vis
  WHERE r.id = ANY(p_ids)
    AND (
      r.user_id = me.uid
      OR me.uid = ANY(COALESCE(r.board_approver_ids, '{}'::uuid[]))
      OR me.uid = ANY(COALESCE(r.requested_manager_ids, '{}'::uuid[]))
      OR me.role_title IN ('マネージャー', '社長')
      OR me.is_admin
    );
$$;

GRANT EXECUTE ON FUNCTION public.purchase_request_approval_progress(uuid[]) TO authenticated;
