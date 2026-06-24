-- 連絡板：実際に送信された時刻を記録する列を追加
-- 即時送信メッセージは作成時に sent_at をセット（フロント側）
-- 予約送信メッセージは board-scheduled-send Edge Function が実際に送信した時にセット
ALTER TABLE board_messages ADD COLUMN IF NOT EXISTS sent_at timestamptz;

-- 既存の送信済みメッセージは created_at を実送信時刻とみなして補完
UPDATE board_messages SET sent_at = created_at WHERE sent_at IS NULL AND status = 'sent';
