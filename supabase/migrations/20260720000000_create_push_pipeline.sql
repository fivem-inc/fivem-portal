-- ============================================================
-- プッシュ通知パイプライン（ベル通知→プッシュの連動）基盤
--
-- 仕組み:
--   notifications INSERT
--     → AFTER INSERTトリガーが push_queue に「送信待ち」を積むだけ
--     → 1分毎のpg_cronが push-dispatch Edge Functionを呼ぶ
--     → user×event_keyで集約し「状態名詞+件数」の固定文面で送信
--
-- トリガーから直接pg_netを叩かない理由:
--   過去にVault未設定でcron系が全滅し失敗が不可視だった事故があるため、
--   キューに「見える形」で残す設計にする。プッシュ側が全滅しても
--   ベル通知本体は無傷（トリガーはEXCEPTION捕捉で必ずRETURN NEW）。
-- ============================================================

-- notifications: プッシュ判定用のイベント種別ラベル
-- （notification_settingsのevent_keyと同じ体系。NULLはプッシュ対象外）
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS event_key text;

-- プッシュ送信待ちキュー
CREATE TABLE IF NOT EXISTS push_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  event_key text NOT NULL,
  reference_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
  error text,
  retry_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_push_queue_pending ON push_queue (status, created_at) WHERE status = 'pending';

-- RLS: ポリシーを作らない＝クライアントからは一切アクセス不可。
-- 書き込みはSECURITY DEFINERトリガー、読み書きはservice_roleのワーカーのみ
ALTER TABLE push_queue ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION enqueue_push_notification()
RETURNS trigger
SECURITY DEFINER
SET search_path = public
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    IF NEW.event_key IS NOT NULL
       -- プッシュを許可している（購読がある）ユーザーだけ積む
       AND EXISTS (SELECT 1 FROM push_subscriptions s WHERE s.user_id = NEW.user_id)
       -- 同一ユーザー×同一イベント×同一対象の送信待ちが既にあれば積まない
       AND NOT EXISTS (
         SELECT 1 FROM push_queue q
         WHERE q.user_id = NEW.user_id
           AND q.event_key = NEW.event_key
           AND q.status = 'pending'
           AND COALESCE(q.reference_id, '') = COALESCE(NEW.reference_id, '')
       )
    THEN
      INSERT INTO push_queue (user_id, event_key, reference_id)
      VALUES (NEW.user_id, NEW.event_key, NEW.reference_id);
    END IF;
  EXCEPTION WHEN OTHERS THEN
    -- キュー投入の失敗でベル通知本体のINSERTを巻き込まない
    NULL;
  END;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_enqueue_push ON notifications;
CREATE TRIGGER trg_enqueue_push
  AFTER INSERT ON notifications
  FOR EACH ROW EXECUTE FUNCTION enqueue_push_notification();

-- ロールバック手順:
--   DROP TRIGGER trg_enqueue_push ON notifications;（ベル通知には無影響）
--   cronは select cron.unschedule('push-dispatch-every-min');
