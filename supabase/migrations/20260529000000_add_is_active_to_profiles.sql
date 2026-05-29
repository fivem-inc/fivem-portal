-- profilesテーブルにis_activeカラムを追加
-- true: 現役, false: 退職済み
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS is_active boolean DEFAULT true;

-- 既存ユーザーはすべて現役として設定
UPDATE profiles SET is_active = true WHERE is_active IS NULL;
