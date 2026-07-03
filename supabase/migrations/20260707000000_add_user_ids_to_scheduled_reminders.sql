-- 定期リマインドの送り先に「個別選択したスタッフ」も指定できるようにする
-- channel_id（グループ）と併用はせず、user_idsが設定されていればそちらを優先する運用とする
ALTER TABLE public.board_scheduled_reminders
  ADD COLUMN IF NOT EXISTS user_ids uuid[];
