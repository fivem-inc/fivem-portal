-- 備品購入申請・経費精算 Phase 4（その4）
-- 全員承認時の自動確定RPC（submit_board_opinion）。Phase3の既存submitOpinion（直接upsert）はそのまま残し、
-- Phase4専用にこちらのRPCを新設して使う。SECURITY INVOKERでRLSに従う。
--
-- 戻り値: true = このRPC呼び出しで全員承認が揃い、board_approvedに自動確定した
--         false = まだ揃っていない（差し戻し等、別経路の最終決定は従来通りUPDATEで行う）

CREATE OR REPLACE FUNCTION public.submit_board_opinion(
  p_purchase_request_id uuid,
  p_opinion text,
  p_comment text,
  p_visible_to_applicant boolean
) RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
AS $$
DECLARE
  v_request public.purchase_requests%ROWTYPE;
  v_opinion_count integer;
  v_approve_count integer;
  v_required_count integer;
BEGIN
  SELECT * INTO v_request
    FROM public.purchase_requests
    WHERE id = p_purchase_request_id
    FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION '対象の申請が見つかりません';
  END IF;

  IF NOT (auth.uid() = ANY(v_request.board_approver_ids)) OR v_request.status != 'pending_board' THEN
    RAISE EXCEPTION 'この申請に意見を提出する権限がありません';
  END IF;

  INSERT INTO public.purchase_request_manager_opinions (
    purchase_request_id, manager_id, opinion, comment, visible_to_applicant, approval_round
  ) VALUES (
    p_purchase_request_id, auth.uid(), p_opinion, p_comment, p_visible_to_applicant, v_request.approval_round
  )
  ON CONFLICT (purchase_request_id, manager_id, approval_round)
  DO UPDATE SET
    opinion = EXCLUDED.opinion,
    comment = EXCLUDED.comment,
    visible_to_applicant = EXCLUDED.visible_to_applicant;

  v_required_count := COALESCE(array_length(v_request.board_approver_ids, 1), 0);

  SELECT count(*), count(*) FILTER (WHERE opinion = 'approve') INTO v_opinion_count, v_approve_count
    FROM public.purchase_request_manager_opinions
    WHERE purchase_request_id = p_purchase_request_id
      AND approval_round = v_request.approval_round;

  IF v_opinion_count >= v_required_count AND v_approve_count >= v_required_count THEN
    UPDATE public.purchase_requests
      SET status = 'board_approved', board_approved_at = now()
      WHERE id = p_purchase_request_id;
    RETURN true;
  END IF;

  RETURN false;
END;
$$;

-- ========================================
-- 通知設定
-- ========================================
INSERT INTO notification_settings (event_key, channel, enabled, recipient, subject, template) VALUES
  ('purchase_request:submitted_board', 'site', true,
    '{"recipients":["manager"]}', null,
    E'🧾 {{申請者名}}さんから備品購入の全員承認依頼が届いています（{{品目名}}・¥{{金額}}）'),
  ('purchase_request:board_opinion_submitted', 'site', true,
    '{"recipients":["manager"]}', null,
    E'💬 {{回答者名}}さんが「{{品目名}}」の申請に意見を提出しました'),
  ('purchase_request:board_all_approved', 'site', true,
    '{"recipients":["applicant"]}', null,
    E'✅ 「{{品目名}}」の申請が全員承認され、確定しました'),
  ('purchase_request:board_denial_present', 'site', true,
    '{"recipients":["manager"]}', null,
    E'⚠️ 「{{品目名}}」の申請に否認意見があります。全員回答後に話し合いが必要です')
ON CONFLICT (event_key, channel) DO NOTHING;
