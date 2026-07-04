-- 備品購入申請・経費精算 Phase 2
-- 「申請」フロー（購入前承認、〜1万円・リーダー承認のみ）を追加する。
-- 既存の精算(reimbursement)レコードには影響を与えない（新規列はNULL許容で追加、
-- request_type/statusのCHECK制約は既存値を含む形に緩和するのみ）。

-- request_type: 'purchase_request'（申請フロー）を追加
ALTER TABLE public.purchase_requests
  DROP CONSTRAINT purchase_requests_request_type_check;
ALTER TABLE public.purchase_requests
  ADD CONSTRAINT purchase_requests_request_type_check
  CHECK (request_type IN ('reimbursement', 'purchase_request'));

-- status: 申請フロー用のステータスを追加
ALTER TABLE public.purchase_requests
  DROP CONSTRAINT purchase_requests_status_check;
ALTER TABLE public.purchase_requests
  ADD CONSTRAINT purchase_requests_status_check
  CHECK (status IN ('recorded', 'pending_leader', 'leader_approved', 'returned'));

-- request_typeとstatusの組み合わせが崩れないようガードする
-- （精算は常にrecorded、申請は申請フロー専用ステータスのみ）
ALTER TABLE public.purchase_requests
  ADD CONSTRAINT purchase_requests_type_status_check
  CHECK (
    (request_type = 'reimbursement' AND status = 'recorded')
    OR (request_type = 'purchase_request' AND status IN ('pending_leader', 'leader_approved', 'returned'))
  );

-- 申請フロー専用の追加列
ALTER TABLE public.purchase_requests
  ADD COLUMN leader_id uuid REFERENCES auth.users(id),
  ADD COLUMN leader_approved_at timestamptz,
  ADD COLUMN returned_reason text,
  -- 申請フローでは「購入予定日」の意味で使う専用列。既存のpurchased_at（精算＝購入実績日）と
  -- 意味を混在させるとバグの温床になるため列を分ける（シニアエンジニアレビュー指摘反映）
  ADD COLUMN requested_purchase_date date,
  -- 相見積もり: [{"vendor":"○○商店","amount":3000}, ...] の配列。
  -- 1万円未満でも「価格を比較したか」の記録用に任意入力できるようにする（コスト意識付けが目的）
  ADD COLUMN quotes jsonb,
  -- 見積書そのものの写真/PDFは任意添付（相見積もり自体はquotesのテキスト入力で成立するため必須にはしない）
  ADD COLUMN quote_file_path text;

-- 1万円以上の申請は相見積もり（2社以上）を必須にする
ALTER TABLE public.purchase_requests
  ADD CONSTRAINT purchase_requests_quotes_required_check
  CHECK (
    request_type != 'purchase_request'
    OR amount < 10000
    OR (quotes IS NOT NULL AND jsonb_array_length(quotes) >= 2)
  );

CREATE INDEX idx_purchase_requests_leader ON public.purchase_requests(leader_id);

-- リーダーは自分が承認先に指定された申請を参照できる
CREATE POLICY "pr_leader_select" ON public.purchase_requests
  FOR SELECT USING (leader_id = auth.uid());

-- リーダーは自分宛の申請中の行のみ承認/差し戻しできる
-- （申請内容フィールドの改ざん防止は下記トリガーで担保。休暇申請等と違いRPC化はせず
--   既存の shift_reports 等と同じ USING/WITH CHECK パターンを踏襲しつつトリガーで補強する）
CREATE POLICY "pr_leader_update" ON public.purchase_requests
  FOR UPDATE
  USING (leader_id = auth.uid() AND status = 'pending_leader')
  WITH CHECK (leader_id = auth.uid() AND status IN ('leader_approved', 'returned'));

-- 申請者は差し戻された自分の申請を修正して再申請できる
CREATE POLICY "pr_applicant_resubmit" ON public.purchase_requests
  FOR UPDATE
  USING (user_id = auth.uid() AND status = 'returned')
  WITH CHECK (user_id = auth.uid() AND status = 'pending_leader');

-- リーダーが承認/差し戻し操作のついでに金額・品目等の申請内容を書き換えられないようにする
-- （RLSのWITH CHECKだけでは「値が変わっていないこと」までは強制できないためトリガーで担保）
CREATE OR REPLACE FUNCTION public.protect_purchase_request_fields()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF auth.uid() = OLD.leader_id AND auth.uid() IS DISTINCT FROM OLD.user_id THEN
    IF NEW.user_id IS DISTINCT FROM OLD.user_id
      OR NEW.item_name IS DISTINCT FROM OLD.item_name
      OR NEW.quantity IS DISTINCT FROM OLD.quantity
      OR NEW.amount IS DISTINCT FROM OLD.amount
      OR NEW.purchased_at IS DISTINCT FROM OLD.purchased_at
      OR NEW.requested_purchase_date IS DISTINCT FROM OLD.requested_purchase_date
      OR NEW.instructed_by IS DISTINCT FROM OLD.instructed_by
      OR NEW.store_name IS DISTINCT FROM OLD.store_name
      OR NEW.purpose IS DISTINCT FROM OLD.purpose
      OR NEW.payment_method IS DISTINCT FROM OLD.payment_method
      OR NEW.notes IS DISTINCT FROM OLD.notes
      OR NEW.receipt_type IS DISTINCT FROM OLD.receipt_type
      OR NEW.receipt_missing_reason IS DISTINCT FROM OLD.receipt_missing_reason
      OR NEW.receipt_storage_path IS DISTINCT FROM OLD.receipt_storage_path
      OR NEW.quotes IS DISTINCT FROM OLD.quotes
      OR NEW.quote_file_path IS DISTINCT FROM OLD.quote_file_path
    THEN
      RAISE EXCEPTION '承認者は申請内容を変更できません（ステータスの更新のみ可能です）';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER purchase_requests_protect_fields
  BEFORE UPDATE ON public.purchase_requests
  FOR EACH ROW EXECUTE FUNCTION public.protect_purchase_request_fields();

-- ========================================
-- 通知設定: 申請時→リーダー、承認/差し戻し時→申請者
-- 個人宛通知（役職一斉ではない）のため、既存の notificationDispatch.ts の
-- dispatchSiteNotification/dispatchEmail（'leader'/'applicant'キー方式）をクライアント側から
-- 呼び出す想定。leave:leader_approved 等と同じパターンでEdge Functionは新設しない。
-- ========================================
INSERT INTO notification_settings (event_key, channel, enabled, recipient, subject, template) VALUES
  ('purchase_request:submitted', 'site', true,
    '{"recipients":["leader"]}', null,
    E'🧾 {{申請者名}}さんから備品購入の承認依頼が届いています（{{品目名}}・¥{{金額}}）'),
  ('purchase_request:leader_approved', 'site', true,
    '{"recipients":["applicant"]}', null,
    E'✅ 備品購入申請（{{品目名}}）が承認されました'),
  ('purchase_request:returned', 'site', true,
    '{"recipients":["applicant"]}', null,
    E'↩️ 備品購入申請（{{品目名}}）が差し戻されました。理由をご確認のうえ修正して再申請してください')
ON CONFLICT (event_key, channel) DO NOTHING;
