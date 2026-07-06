-- 備品購入申請 複数商品対応 ステップ1（その4）
-- purchase_request_items / purchase_request_item_quotes のRLS。
-- 既存のpurchase_requests RLS・改ざん防止トリガーのスタイルを踏襲する。
--
-- SELECT: 親のpurchase_requests行が見えれば明細も見える（親側のRLSに実質委譲するだけのシンプルな形）。
-- INSERT/UPDATE/DELETE: 申請者本人(pr.user_id = auth.uid())であることに加え、
--   親のstatusが「まだ承認確定していない」状態（pending_leader/pending_manager/pending_board/
--   self_judgment_shared/returned）であることをWITH CHECKで要求する。
--   これにより承認確定後(leader_approved/manager_approved/board_approved)は申請者でも明細を
--   書き換えられなくなる。また承認者自身はpr.user_id = auth.uid()を満たさないため、
--   そもそも最初から明細への書き込みができない（承認者による明細改ざん防止）。

ALTER TABLE public.purchase_request_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_request_item_quotes ENABLE ROW LEVEL SECURITY;

-- ========================================
-- purchase_request_items
-- ========================================
CREATE POLICY "pr_items_select" ON public.purchase_request_items
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.purchase_requests pr
      WHERE pr.id = purchase_request_id
    )
  );

CREATE POLICY "pr_items_all" ON public.purchase_request_items
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.purchase_requests pr
      WHERE pr.id = purchase_request_id
        AND pr.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.purchase_requests pr
      WHERE pr.id = purchase_request_id
        AND pr.user_id = auth.uid()
        AND pr.status IN ('pending_leader', 'pending_manager', 'pending_board', 'self_judgment_shared', 'returned')
    )
  );

-- ========================================
-- purchase_request_item_quotes（purchase_request_items経由でさらにpurchase_requestsを辿る2段JOIN）
-- ========================================
CREATE POLICY "pr_item_quotes_select" ON public.purchase_request_item_quotes
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.purchase_request_items pri
      JOIN public.purchase_requests pr ON pr.id = pri.purchase_request_id
      WHERE pri.id = purchase_request_item_id
    )
  );

CREATE POLICY "pr_item_quotes_all" ON public.purchase_request_item_quotes
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.purchase_request_items pri
      JOIN public.purchase_requests pr ON pr.id = pri.purchase_request_id
      WHERE pri.id = purchase_request_item_id
        AND pr.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.purchase_request_items pri
      JOIN public.purchase_requests pr ON pr.id = pri.purchase_request_id
      WHERE pri.id = purchase_request_item_id
        AND pr.user_id = auth.uid()
        AND pr.status IN ('pending_leader', 'pending_manager', 'pending_board', 'self_judgment_shared', 'returned')
    )
  );
