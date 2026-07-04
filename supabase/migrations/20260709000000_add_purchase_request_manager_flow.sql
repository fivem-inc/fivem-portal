-- 備品購入申請・経費精算 Phase 3
-- 「申請」フローに1万円超〜3万円帯（マネージャー承認 or 自己判断＝共有のみ）を追加する。
-- 3万円超（Phase4・全員承認フロー）はまだ対象外。amount<=30000のガードで暴発を防ぐ。
--
-- 金額帯としきい値は複数の制約に登場するため、変更時は下記3箇所をまとめて確認すること：
--   1. purchase_requests_amount_band_check（3万円超ガード）
--   2. purchase_requests_type_status_check（金額帯とstatus/承認ルートの整合）
--   3. purchase_requests_self_judgment_amount_check（自己判断は1万円超のみ許可）
--   4. purchase_requests_quotes_required_check（Phase2で追加済み、1万円超で相見積もり必須。今回変更なし）

-- 3万円超の申請は今回未対応（Phase4で対応予定）のためガードする
ALTER TABLE public.purchase_requests
  ADD CONSTRAINT purchase_requests_amount_band_check
  CHECK (request_type != 'purchase_request' OR amount <= 30000);

-- status: マネージャー承認・自己判断共有用のステータスを追加
ALTER TABLE public.purchase_requests
  DROP CONSTRAINT purchase_requests_status_check;
ALTER TABLE public.purchase_requests
  ADD CONSTRAINT purchase_requests_status_check
  CHECK (status IN ('recorded', 'pending_leader', 'leader_approved', 'pending_manager', 'manager_approved', 'self_judgment_shared', 'returned'));

-- 申請フロー専用の追加列
ALTER TABLE public.purchase_requests
  -- マネージャー承認ルート用（leader_idと対称、単数）
  ADD COLUMN manager_id uuid REFERENCES auth.users(id),
  ADD COLUMN manager_approved_at timestamptz,
  -- 自己判断（共有のみ）チェック。trueの場合は承認ゲートを経ずshared_manager_idsへ共有通知のみ行う
  ADD COLUMN is_self_judgment boolean NOT NULL DEFAULT false,
  -- 自己判断ルート用の共有先（複数選択、同じ部署のマネージャー数名を想定）
  ADD COLUMN shared_manager_ids uuid[];

CREATE INDEX idx_purchase_requests_manager ON public.purchase_requests(manager_id);
CREATE INDEX idx_purchase_requests_shared_managers ON public.purchase_requests USING GIN (shared_manager_ids);

-- is_self_judgmentは1万円超（マネージャー承認帯）でのみ許可する
-- （1万円以下はリーダー承認固定。自己判断で承認自体を省略できるのはPhase3の金額帯のみという業務要件）
ALTER TABLE public.purchase_requests
  ADD CONSTRAINT purchase_requests_self_judgment_amount_check
  CHECK (NOT is_self_judgment OR amount > 10000);

-- is_self_judgmentの値によって使用する列（manager_id側かshared_manager_ids側か）を排他にする
ALTER TABLE public.purchase_requests
  ADD CONSTRAINT purchase_requests_self_judgment_columns_check
  CHECK (
    (is_self_judgment AND manager_id IS NULL AND shared_manager_ids IS NOT NULL AND array_length(shared_manager_ids, 1) >= 1)
    OR (NOT is_self_judgment AND shared_manager_ids IS NULL)
  );

-- request_typeとstatusの組み合わせ、および金額帯ごとの承認ルートの整合を守る
-- （1万円以下＝リーダー承認固定、1万円超＝マネージャー承認 or 自己判断共有のみ）
ALTER TABLE public.purchase_requests
  DROP CONSTRAINT purchase_requests_type_status_check;
ALTER TABLE public.purchase_requests
  ADD CONSTRAINT purchase_requests_type_status_check
  CHECK (
    (request_type = 'reimbursement' AND status = 'recorded')
    OR (request_type = 'purchase_request' AND amount <= 10000 AND NOT is_self_judgment AND status IN ('pending_leader', 'leader_approved', 'returned'))
    OR (request_type = 'purchase_request' AND amount > 10000 AND NOT is_self_judgment AND status IN ('pending_manager', 'manager_approved', 'returned'))
    OR (request_type = 'purchase_request' AND amount > 10000 AND is_self_judgment AND status = 'self_judgment_shared')
  );

-- マネージャーは自分が承認先に指定された申請を参照できる（leader_id版のpr_leader_selectと対称）
CREATE POLICY "pr_manager_select" ON public.purchase_requests
  FOR SELECT USING (manager_id = auth.uid());

-- マネージャーは自分宛の申請中の行のみ承認/差し戻しできる
CREATE POLICY "pr_manager_update" ON public.purchase_requests
  FOR UPDATE
  USING (manager_id = auth.uid() AND status = 'pending_manager')
  WITH CHECK (manager_id = auth.uid() AND status IN ('manager_approved', 'returned'));

-- 自己判断（共有のみ）で共有先に指定されたマネージャーは、FYI確認のため参照だけできる（承認アクションは無い）
CREATE POLICY "pr_shared_manager_select" ON public.purchase_requests
  FOR SELECT USING (auth.uid() = ANY(shared_manager_ids));

-- 申請者が差し戻された自分の申請を再申請できる範囲を、マネージャー承認ルートにも拡張
-- （金額帯を書き換えて再申請するとリーダー/マネージャーのどちらの承認ルートにもなり得るため、
--   遷移先の妥当性はこのポリシーではなくpurchase_requests_type_status_checkに委ねる）
DROP POLICY IF EXISTS "pr_applicant_resubmit" ON public.purchase_requests;
CREATE POLICY "pr_applicant_resubmit" ON public.purchase_requests
  FOR UPDATE
  USING (user_id = auth.uid() AND status = 'returned')
  WITH CHECK (user_id = auth.uid() AND status IN ('pending_leader', 'pending_manager'));

-- 承認者（リーダー/マネージャー）による申請内容の改ざん防止トリガーに、
-- マネージャー承認ルート・自己判断ルート関連の列を追加する
CREATE OR REPLACE FUNCTION public.protect_purchase_request_fields()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (auth.uid() = OLD.leader_id OR auth.uid() = OLD.manager_id) AND auth.uid() IS DISTINCT FROM OLD.user_id THEN
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
      OR NEW.leader_id IS DISTINCT FROM OLD.leader_id
      OR NEW.manager_id IS DISTINCT FROM OLD.manager_id
      OR NEW.shared_manager_ids IS DISTINCT FROM OLD.shared_manager_ids
      OR NEW.is_self_judgment IS DISTINCT FROM OLD.is_self_judgment
    THEN
      RAISE EXCEPTION '承認者は申請内容を変更できません（ステータスの更新のみ可能です）';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ========================================
-- 通知設定: 申請時→マネージャー、承認/差し戻し時→申請者、自己判断共有時→共有先マネージャー（複数）
-- 複数宛先（shared_manager_ids）はnotificationDispatch.tsのrecipients方式では単一キーしか
-- 表現できないため、クライアント側で配列をループしてinsertNotification/送信する
-- ========================================
INSERT INTO notification_settings (event_key, channel, enabled, recipient, subject, template) VALUES
  ('purchase_request:submitted_manager', 'site', true,
    '{"recipients":["manager"]}', null,
    E'🧾 {{申請者名}}さんから備品購入の承認依頼が届いています（{{品目名}}・¥{{金額}}）'),
  ('purchase_request:manager_approved', 'site', true,
    '{"recipients":["applicant"]}', null,
    E'✅ 備品購入申請（{{品目名}}）が承認されました'),
  ('purchase_request:self_judgment_shared', 'site', true,
    '{"recipients":["manager"]}', null,
    E'ℹ️ {{申請者名}}さんが自己判断で備品を購入します（共有）（{{品目名}}・¥{{金額}}）')
ON CONFLICT (event_key, channel) DO NOTHING;
