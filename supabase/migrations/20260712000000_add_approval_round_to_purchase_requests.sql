-- 備品購入申請・経費精算 Phase 3（続き3）
-- 差し戻し→再申請は同一レコードのUPDATE方式のため、purchase_request_manager_opinionsの
-- unique(purchase_request_id, manager_id)制約のままだと、再申請後に同じマネージャーへ
-- 再度意見を求めた際に前回の意見行がupsertで上書きされるだけになり、
-- 「今回の再申請に対する新しい意見が全員分揃ったか」を正しく判定できない
-- （古い意見がそのまま「回答済み」として数えられてしまう）バグがあった。
--
-- 対応：purchase_requests・purchase_request_manager_opinions双方にapproval_round列を追加し、
-- 再申請のたびにapproval_roundをインクリメントすることで、ラウンドごとに意見を区別する。

-- ========================================
-- 1. approval_round列の追加
-- ========================================
ALTER TABLE public.purchase_requests
  ADD COLUMN approval_round integer NOT NULL DEFAULT 1;

ALTER TABLE public.purchase_request_manager_opinions
  ADD COLUMN approval_round integer NOT NULL DEFAULT 1;

-- ========================================
-- 2. 意見テーブルの一意制約をラウンド込みに変更
-- ========================================
ALTER TABLE public.purchase_request_manager_opinions
  DROP CONSTRAINT purchase_request_manager_opin_purchase_request_id_manager_i_key;
ALTER TABLE public.purchase_request_manager_opinions
  ADD CONSTRAINT purchase_request_manager_opin_purchase_request_id_manager_i_key
  UNIQUE (purchase_request_id, manager_id, approval_round);

-- ========================================
-- 3. 「全員の意見が揃うまで最終決定不可」ゲートを、対象ラウンドの意見件数で判定するよう修正
-- 加えて、シニアエンジニアレビュー指摘の「purchase_requests本体行のロックが弱い」問題に対応するため、
-- 意見テーブルのロックをFOR SHAREからFOR UPDATEに強化する
-- ========================================
CREATE OR REPLACE FUNCTION public.enforce_manager_opinions_complete()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  opinion_count integer;
  required_count integer;
BEGIN
  IF OLD.status = 'pending_manager' AND NEW.status IN ('manager_approved', 'returned') AND NOT NEW.is_self_judgment THEN
    required_count := COALESCE(array_length(NEW.requested_manager_ids, 1), 0);
    -- 意見upsertとの競合を避けるため対象行をロックしてからカウントする
    -- （FOR SHAREからFOR UPDATEへ強化し、より厳密に排他制御する）
    SELECT count(*) INTO opinion_count
      FROM public.purchase_request_manager_opinions
      WHERE purchase_request_id = NEW.id
        AND approval_round = NEW.approval_round
      FOR UPDATE;
    IF opinion_count < required_count THEN
      RAISE EXCEPTION '依頼した全員の意見が揃うまで最終決定はできません（%件中%件回答済み）', required_count, opinion_count;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ========================================
-- 4. opinion_insertポリシーを再定義し、挿入するapproval_roundが
-- 対象purchase_requestsの現在のapproval_roundと一致することを要求する
-- （なりすまし・古いラウンドへの誤挿入対策）
-- ========================================
DROP POLICY "opinion_insert" ON public.purchase_request_manager_opinions;
CREATE POLICY "opinion_insert" ON public.purchase_request_manager_opinions
  FOR INSERT WITH CHECK (
    manager_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.purchase_requests pr
      WHERE pr.id = purchase_request_id
        AND auth.uid() = ANY(pr.requested_manager_ids)
        AND pr.status = 'pending_manager'
        AND pr.approval_round = approval_round
    )
  );

-- ========================================
-- 5. opinion_updateポリシーも同様に、対象行のapproval_roundが現在のapproval_roundと
-- 一致する場合のみ更新可能にする（既にconfirmedなラウンドの意見を後から書き換えられないようにする）
-- ========================================
DROP POLICY "opinion_update" ON public.purchase_request_manager_opinions;
CREATE POLICY "opinion_update" ON public.purchase_request_manager_opinions
  FOR UPDATE
  USING (manager_id = auth.uid())
  WITH CHECK (
    manager_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.purchase_requests pr
      WHERE pr.id = purchase_request_id
        AND auth.uid() = ANY(pr.requested_manager_ids)
        AND pr.status = 'pending_manager'
        AND pr.approval_round = approval_round
    )
  );
