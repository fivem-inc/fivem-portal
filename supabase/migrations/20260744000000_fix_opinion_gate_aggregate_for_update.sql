-- 🚨 承認の最終決定が必ず失敗する潜在バグの修復（2026-07-30 発見・実害あり）
--
-- 【症状】曽川マネージャーがビジネスフォン申請（全員承認・5人目＝最後の1人）の
--   意見を送信したところエラーになり、意見も保存されなかった（トランザクションごとロールバック）。
--
-- 【原因】PostgreSQLでは「集計関数（count等）と FOR UPDATE は同じSELECTに書けない」
--   （ERROR: FOR UPDATE is not allowed with aggregate functions）。
--   2026-07-04〜06セッションの排他制御強化（FOR SHARE → FOR UPDATE）で、
--   count(*) と FOR UPDATE を同居させてしまい、以下の2関数が「発火した瞬間に必ず失敗する」
--   状態になっていた：
--     1. enforce_board_opinions_complete   … 全員承認の確定・差し戻し時（pending_board → board_approved/returned）
--     2. enforce_manager_opinions_complete … マネージャー承認の最終決定時（pending_manager → manager_approved/returned）
--   全員の回答が揃う前の意見送信は UPDATE を伴わないため成功しており、
--   「最後の1人の送信＝最終決定」で初めて発火する。今回が本番で最初に踏んだケース。
--   ＝今日の変更とは無関係の、Phase 3/4 実装時からの潜在バグ。
--
-- 【修正】行ロックと集計を分ける：先に PERFORM ... FOR UPDATE で対象ラウンドの意見行を
--   ロックし、その後ロック句なしで数える（排他制御の意図は維持したまま構文エラーを解消）。

-- 1. 全員承認（board）ゲート
CREATE OR REPLACE FUNCTION public.enforce_board_opinions_complete()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  opinion_count integer;
  approve_count integer;
  required_count integer;
BEGIN
  IF OLD.status = 'pending_board' AND NEW.status IN ('board_approved', 'returned') THEN
    required_count := COALESCE(array_length(NEW.board_approver_ids, 1), 0);
    -- 意見upsertとの競合を避けるため対象行をロックする
    -- （集計関数と FOR UPDATE は同じSELECTに書けないため、ロックと集計を分ける）
    PERFORM 1 FROM public.purchase_request_manager_opinions
      WHERE purchase_request_id = NEW.id
        AND approval_round = NEW.approval_round
      FOR UPDATE;
    SELECT count(*), count(*) FILTER (WHERE opinion = 'approve') INTO opinion_count, approve_count
      FROM public.purchase_request_manager_opinions
      WHERE purchase_request_id = NEW.id
        AND approval_round = NEW.approval_round;
    IF opinion_count < required_count THEN
      RAISE EXCEPTION '全員の回答が揃うまで最終決定はできません（%件中%件回答済み）', required_count, opinion_count;
    END IF;
    IF NEW.status = 'board_approved' AND approve_count < required_count THEN
      RAISE EXCEPTION '全員が承認している場合のみ全員承認として確定できます（否認を含む場合は差し戻してください）';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- 2. マネージャー承認ゲート
CREATE OR REPLACE FUNCTION public.enforce_manager_opinions_complete()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  opinion_count integer;
  required_count integer;
BEGIN
  IF OLD.status = 'pending_manager' AND NEW.status IN ('manager_approved', 'returned') AND NOT NEW.is_self_judgment THEN
    required_count := COALESCE(array_length(NEW.requested_manager_ids, 1), 0);
    PERFORM 1 FROM public.purchase_request_manager_opinions
      WHERE purchase_request_id = NEW.id
        AND approval_round = NEW.approval_round
      FOR UPDATE;
    SELECT count(*) INTO opinion_count
      FROM public.purchase_request_manager_opinions
      WHERE purchase_request_id = NEW.id
        AND approval_round = NEW.approval_round;
    IF opinion_count < required_count THEN
      RAISE EXCEPTION '依頼した全員の意見が揃うまで最終決定はできません（%件中%件回答済み）', required_count, opinion_count;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
