-- 備品購入申請・経費精算 Phase 3（続き）
-- 「承認を依頼する」ルートをマネージャー単数選択→複数選択に変更し、
-- 各マネージャーが意見（承認/否認/判断できない/その他＋任意コメント）を残せる審議機能を追加する。
-- 全員の意見が揃うまでは最終的な承認/差し戻しができないゲートをDBトリガーで強制する。
-- 全員一致は要件ではなく、意見が出揃った後は依頼された誰か1人が最終決定してよい。

-- ========================================
-- 1. manager_id（単数）→ requested_manager_ids（複数）への置き換え
-- ========================================
ALTER TABLE public.purchase_requests
  ADD COLUMN requested_manager_ids uuid[];

UPDATE public.purchase_requests
  SET requested_manager_ids = ARRAY[manager_id]
  WHERE manager_id IS NOT NULL;

CREATE INDEX idx_purchase_requests_requested_managers ON public.purchase_requests USING GIN (requested_manager_ids);

-- is_self_judgmentの排他制約をrequested_manager_ids基準に書き換え
ALTER TABLE public.purchase_requests
  DROP CONSTRAINT purchase_requests_self_judgment_columns_check;
ALTER TABLE public.purchase_requests
  ADD CONSTRAINT purchase_requests_self_judgment_columns_check
  CHECK (
    (is_self_judgment AND requested_manager_ids IS NULL AND shared_manager_ids IS NOT NULL AND array_length(shared_manager_ids, 1) >= 1)
    OR (NOT is_self_judgment AND shared_manager_ids IS NULL)
  );

DROP POLICY "pr_manager_select" ON public.purchase_requests;
CREATE POLICY "pr_manager_select" ON public.purchase_requests
  FOR SELECT USING (auth.uid() = ANY(requested_manager_ids));

DROP POLICY "pr_manager_update" ON public.purchase_requests;
-- 依頼された誰か1人が最終決定（承認/差し戻し）できる。全員の意見が揃っているかは
-- 下記enforce_manager_opinions_complete()トリガーで別途強制する（全員一致は不要）
CREATE POLICY "pr_manager_update" ON public.purchase_requests
  FOR UPDATE
  USING (auth.uid() = ANY(requested_manager_ids) AND status = 'pending_manager')
  WITH CHECK (auth.uid() = ANY(requested_manager_ids) AND status IN ('manager_approved', 'returned'));

-- 改ざん防止トリガーのmanager_id参照をrequested_manager_idsに置き換え
CREATE OR REPLACE FUNCTION public.protect_purchase_request_fields()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (auth.uid() = OLD.leader_id OR auth.uid() = ANY(OLD.requested_manager_ids)) AND auth.uid() IS DISTINCT FROM OLD.user_id THEN
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
      OR NEW.requested_manager_ids IS DISTINCT FROM OLD.requested_manager_ids
      OR NEW.shared_manager_ids IS DISTINCT FROM OLD.shared_manager_ids
      OR NEW.is_self_judgment IS DISTINCT FROM OLD.is_self_judgment
    THEN
      RAISE EXCEPTION '承認者は申請内容を変更できません（ステータスの更新のみ可能です）';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- manager_id列は役目を終えたため削除（依存していたインデックス・列とも削除）
DROP INDEX IF EXISTS idx_purchase_requests_manager;
ALTER TABLE public.purchase_requests DROP COLUMN manager_id;

-- ========================================
-- 2. マネージャー審議（意見）テーブル
-- ========================================
CREATE TABLE public.purchase_request_manager_opinions (
  id uuid primary key default gen_random_uuid(),
  purchase_request_id uuid not null references public.purchase_requests(id) on delete cascade,
  manager_id uuid not null references auth.users(id),
  opinion text not null check (opinion in ('approve', 'deny', 'undecided', 'other')),
  comment text,
  -- 申請者本人にもこの意見（opinion・commentとも）を共有するかを回答者が選べる
  visible_to_applicant boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (purchase_request_id, manager_id)
);

CREATE OR REPLACE FUNCTION public.update_purchase_request_manager_opinions_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER purchase_request_manager_opinions_updated_at
  BEFORE UPDATE ON public.purchase_request_manager_opinions
  FOR EACH ROW EXECUTE FUNCTION public.update_purchase_request_manager_opinions_updated_at();

ALTER TABLE public.purchase_request_manager_opinions ENABLE ROW LEVEL SECURITY;

-- 依頼された全マネージャー・申請者本人が閲覧できる。
-- ただし申請者本人はvisible_to_applicant=trueの行のみ見える（マネージャーは全行見える）
CREATE POLICY "opinion_select" ON public.purchase_request_manager_opinions
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.purchase_requests pr
      WHERE pr.id = purchase_request_id AND auth.uid() = ANY(pr.requested_manager_ids)
    )
    OR (
      visible_to_applicant
      AND EXISTS (SELECT 1 FROM public.purchase_requests pr WHERE pr.id = purchase_request_id AND pr.user_id = auth.uid())
    )
  );

-- 本人（依頼されたマネージャーのみ）が自分の意見をinsertできる。
-- 依頼されていない第三者がmanager_id列に自分のuidを詐称して挿入できないよう、
-- 「実際にrequested_manager_idsに含まれるか」をWITH CHECKで検証する（なりすまし対策）。
-- 最終決定後（status!='pending_manager'）は新規投稿も不可にする。
CREATE POLICY "opinion_insert" ON public.purchase_request_manager_opinions
  FOR INSERT WITH CHECK (
    manager_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.purchase_requests pr
      WHERE pr.id = purchase_request_id AND auth.uid() = ANY(pr.requested_manager_ids) AND pr.status = 'pending_manager'
    )
  );

-- 本人は自分の意見を変更できる。ただし最終決定後（status!='pending_manager'）は変更不可
-- （監査上の整合性のため、確定後に意見を書き換えられないようにする）
CREATE POLICY "opinion_update" ON public.purchase_request_manager_opinions
  FOR UPDATE
  USING (manager_id = auth.uid())
  WITH CHECK (
    manager_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.purchase_requests pr
      WHERE pr.id = purchase_request_id AND auth.uid() = ANY(pr.requested_manager_ids) AND pr.status = 'pending_manager'
    )
  );

-- ========================================
-- 3. 「全員の意見が揃うまで最終決定不可」のゲート（DBトリガーで強制、UI回避対策）
-- 「全員の回答」＝依頼された人数分の意見行が存在すること（「判断できない」も有効な回答の1つ）
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
    SELECT count(*) INTO opinion_count
      FROM public.purchase_request_manager_opinions
      WHERE purchase_request_id = NEW.id
      FOR SHARE;
    IF opinion_count < required_count THEN
      RAISE EXCEPTION '依頼した全員の意見が揃うまで最終決定はできません（%件中%件回答済み）', required_count, opinion_count;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER purchase_requests_enforce_opinions_complete
  BEFORE UPDATE ON public.purchase_requests
  FOR EACH ROW EXECUTE FUNCTION public.enforce_manager_opinions_complete();

-- ========================================
-- 通知設定: 意見提出時→他の依頼済みマネージャーへ、全員揃った時→依頼済み全マネージャーへ
-- 複数宛先はnotificationDispatch.tsのrecipients方式では表現できないため、
-- クライアント側でrequested_manager_idsをループしてinsertNotificationする
-- ========================================
INSERT INTO notification_settings (event_key, channel, enabled, recipient, subject, template) VALUES
  ('purchase_request:manager_opinion_submitted', 'site', true,
    '{"recipients":["manager"]}', null,
    E'💬 {{回答者名}}さんが「{{品目名}}」の申請に意見を提出しました'),
  ('purchase_request:manager_opinions_ready', 'site', true,
    '{"recipients":["manager"]}', null,
    E'✅ 「{{品目名}}」の申請で全員の意見が出揃いました。最終決定をお願いします')
ON CONFLICT (event_key, channel) DO NOTHING;
