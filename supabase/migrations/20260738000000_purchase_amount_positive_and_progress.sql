-- 備品購入申請・経費精算：0円の禁止と、承認の進み具合を正しく数えるための集計関数
-- ✅ 2026-07-30 本番実行済み（Supabase SQL Editor）
--
-- ========================================
-- 【背景1】0円が通っていた（承認統制の抜け道）
-- ========================================
--   amount の CHECK は `>= 0` で、Phase 1（精算のみ・承認ルートが存在しなかった頃）に
--   「マイナス禁止」の意味で書かれたもの。その後 Phase 2〜4 で「金額によって承認ルートが決まる」
--   仕組みを足したときに見直しておらず、0円で申請できる状態が残っていた。
--
--   金額は ①誰が承認するか ②相見積もりが必須か ③自己判断できるか を同時に決めるため、
--   0円で出すと「3万円超＝全マネージャー＋社長の全員承認」が必要な案件でも
--   いちばん緩い「1万円以下＝リーダー1名の承認」に落ち、相見積もり2社以上の必須判定も外れる。
--
--   実際に、各校分をまとめた高額案件が「金額は別表（マネージャー回覧）参照」の意図で0円申請され、
--   リーダー1名の承認で受理まで通ってしまった事例が発生した（2026-07-30に発覚）。
--   → 1円以上を必須にする。金額が未確定なら概算を入れる運用（乖離理由の仕組みが既にある）。
--
--   ⚠️ NOT VALID は「既存行を検査しない」だけで、その行を UPDATE するときは検査される。
--      そのため既存の0円行は「削除だけできる」凍結状態になる（修正・承認・差し戻し・取消は不可）。
--      ユーザー判断で、既存の0円申請は正しい金額で作り直したうえで削除する方針とした。
--      残存確認用SQL:
--        select id, item_name, amount, status from purchase_requests where amount <= 0;
--        select id, item_name, amount from purchase_request_items where amount <= 0;
--        select id, vendor, unit_amount from purchase_request_item_quotes where unit_amount <= 0;
--
--   既存の `>= 0` の制約はそのまま残す（`> 0` に包含されるため害はない）。
--   クライアント側にも1円以上の入力チェックを入れており、こちらはREST直叩きに対する後ろ盾。
--
-- ========================================
-- 【背景2】申請者に見える「回答済み件数」が間違っていた
-- ========================================
--   purchase_request_manager_opinions のRLSは、申請者には visible_to_applicant = true の意見しか返さない。
--   クライアントはその件数をそのまま「回答済み」として数えていたため、
--   実際は4名回答済みでも「5名中1名回答済み」と表示され、管理画面（残1名：〇〇）とズレていた。
--   さらに「誰の回答を待っているか」が分からないため、申請者が確認を依頼できなかった。
--   → 件数と未回答者だけを返す SECURITY DEFINER の集計関数を用意する。
--      意見の中身（comment）は返さないので、「共有しない」を選んだコメントは申請者に漏れない。

-- ========================================
-- 1. 金額は1円以上（申請・精算・相見積もりの単価）
-- ========================================
ALTER TABLE public.purchase_requests
  ADD CONSTRAINT purchase_requests_amount_positive_check CHECK (amount > 0) NOT VALID;

ALTER TABLE public.purchase_request_items
  ADD CONSTRAINT purchase_request_items_amount_positive_check CHECK (amount > 0) NOT VALID;

ALTER TABLE public.purchase_request_item_quotes
  ADD CONSTRAINT purchase_request_item_quotes_unit_amount_positive_check CHECK (unit_amount > 0) NOT VALID;

-- ========================================
-- 2. 承認の進み具合（件数と未回答者のみ。意見の中身は返さない）
-- ========================================
-- 対象は全員承認ルート（board_approver_ids）とマネージャー承認ルート（requested_manager_ids）。
-- 呼べるのは「申請者本人・その申請の承認者・管理者」だけ（WHERE句で制限）。
CREATE OR REPLACE FUNCTION public.purchase_request_approval_progress(p_ids uuid[])
RETURNS TABLE (
  purchase_request_id uuid,
  answered integer,
  required integer,
  pending_ids uuid[]
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    r.id,
    (
      SELECT count(*)::integer
      FROM purchase_request_manager_opinions o
      WHERE o.purchase_request_id = r.id
        AND o.approval_round = r.approval_round
    ) AS answered,
    COALESCE(array_length(a.ids, 1), 0)::integer AS required,
    (
      SELECT COALESCE(array_agg(x), '{}'::uuid[])
      FROM unnest(COALESCE(a.ids, '{}'::uuid[])) AS x
      WHERE NOT EXISTS (
        SELECT 1
        FROM purchase_request_manager_opinions o
        WHERE o.purchase_request_id = r.id
          AND o.approval_round = r.approval_round
          AND o.manager_id = x
      )
    ) AS pending_ids
  FROM purchase_requests r
  CROSS JOIN LATERAL (
    SELECT COALESCE(r.board_approver_ids, r.requested_manager_ids) AS ids
  ) a
  WHERE r.id = ANY(p_ids)
    AND (
      r.user_id = auth.uid()
      OR auth.uid() = ANY(COALESCE(r.board_approver_ids, '{}'::uuid[]))
      OR auth.uid() = ANY(COALESCE(r.requested_manager_ids, '{}'::uuid[]))
      OR (auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
    );
$$;

GRANT EXECUTE ON FUNCTION public.purchase_request_approval_progress(uuid[]) TO authenticated;
