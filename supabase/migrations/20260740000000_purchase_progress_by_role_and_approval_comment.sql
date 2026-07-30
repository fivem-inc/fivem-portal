-- 備品購入申請：承認の進み具合を申請者の役職で出し分ける／承認時のひとことを残せるようにする
--
-- ========================================
-- 【背景1】申請者の役職によって見せる情報を変える
-- ========================================
--   2026-07-30に「未回答者の名前」を申請者へ表示したが、申請者の役職に関係なく名前を返していた。
--   運用方針は「申請者がマネージャー以上なら全部見せる／それ以外は件数だけ」なので、
--   関数側で出し分ける（クライアントで隠すだけでは、REST直叩きで名前が取れてしまう）。
--
--   ・マネージャー以上の申請者／その申請の承認者／管理者 → 名前も内訳も返す
--   ・それ以外の申請者（リーダー・フロア責任者・一般・パート） → 件数だけ返す（名前は空で返す）
--
--   answers には「誰が・どう答えたか」だけを入れ、コメントは含めない（コメントの公開は下記RLSで制御）。
--
-- ========================================
-- 【背景2】申請者がマネージャー以上ならコメントも見せる
-- ========================================
--   意見のコメントは回答者が「☐ 申請者にも共有する」で公開を選ぶ方式（既定OFF）。
--   ただし申請者がマネージャー以上の場合は、最終的に議案として審議する相手なので常に共有する。
--   ＝チェックボックスの意味は「マネージャー以外の申請者にも見せるか」になる（画面の文言も直す）。
--
-- ========================================
-- 【背景3】承認時のひとことが残せなかった
-- ========================================
--   差し戻しには理由（returned_reason・必須）があるが、承認には何も残せなかった。
--   「今回は認めるが次回は事前に相談してほしい」のような一言を残せるよう列を追加する。
--   人が「承認」を押すルート（1万円以下のリーダー承認／1万円超〜3万円のマネージャー承認）で任意入力。
--   3万円超は全員承認で自動確定するため押す人がおらず対象外（各自が意見のコメントで代替できる）。

-- ========================================
-- 1. 承認時のひとこと
-- ========================================
ALTER TABLE public.purchase_requests
  ADD COLUMN approval_comment text;

-- ========================================
-- 2. 意見の閲覧権限：申請者がマネージャー以上なら共有チェック不問で全件見える
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
    -- 申請者がマネージャー以上なら、共有チェックの有無に関係なく全件見える
    OR EXISTS (
      SELECT 1 FROM public.purchase_requests pr
      JOIN public.profiles p ON p.id = auth.uid()
      WHERE pr.id = purchase_request_id
        AND pr.user_id = auth.uid()
        AND p.role_title IN ('マネージャー', '社長')
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
-- 3. 承認の進み具合（役職で出し分け）
-- ========================================
-- 戻り値が変わるため作り直す（CREATE OR REPLACE では戻り値の型を変更できない）
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
      OR me.uid = ANY(COALESCE(r.board_approver_ids, '{}'::uuid[]))
      OR me.uid = ANY(COALESCE(r.requested_manager_ids, '{}'::uuid[]))
      OR (r.user_id = me.uid AND me.role_title IN ('マネージャー', '社長'))
    ) AS can_see_names
  ) vis
  WHERE r.id = ANY(p_ids)
    AND (
      r.user_id = me.uid
      OR me.uid = ANY(COALESCE(r.board_approver_ids, '{}'::uuid[]))
      OR me.uid = ANY(COALESCE(r.requested_manager_ids, '{}'::uuid[]))
      OR me.is_admin
    );
$$;

GRANT EXECUTE ON FUNCTION public.purchase_request_approval_progress(uuid[]) TO authenticated;
