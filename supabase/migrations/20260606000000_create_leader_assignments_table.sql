-- 休暇申請ページの「勤務校リーダー・マネージャー一覧」を管理画面から編集できるようにするテーブル
CREATE TABLE leader_assignments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  course TEXT NOT NULL,        -- コース見出し（例: こども、ジュニア、ウェルネス、管理部）
  school TEXT NOT NULL,        -- 校舎・対象（例: 四条本校、全校）
  leader TEXT NOT NULL,        -- リーダー名（複数人は改行区切り）
  manager TEXT NOT NULL,       -- マネージャー名
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE leader_assignments ENABLE ROW LEVEL SECURITY;

-- 全認証ユーザーが閲覧可能（休暇申請フォームで誰でも参照する必要があるため）
CREATE POLICY "Authenticated users can view leader assignments."
  ON leader_assignments FOR SELECT
  TO authenticated
  USING (true);

-- 編集は管理者のみ
CREATE POLICY "Admins can insert leader assignments."
  ON leader_assignments FOR INSERT
  TO authenticated
  WITH CHECK ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

CREATE POLICY "Admins can update leader assignments."
  ON leader_assignments FOR UPDATE
  TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

CREATE POLICY "Admins can delete leader assignments."
  ON leader_assignments FOR DELETE
  TO authenticated
  USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

-- 初期データ（現状ハードコードされている内容を移行）
INSERT INTO leader_assignments (course, school, leader, manager, display_order) VALUES
  ('こども', '四条本校', E'太田 英次朗\n清水 治彦\n森本 純矢', '長岡 貴子', 1),
  ('こども', '西陣校', '清水 治彦', '西村 友彦', 2),
  ('こども', '上桂校', '清水 治彦', '西村 友彦', 3),
  ('こども', '洛西口校', '太田 英次朗', '長岡 貴子', 4),
  ('こども', '南草津校', '太田 英次朗', '長岡 貴子', 5),
  ('ジュニア', E'四条本校\n洛西口校', '曽川 裕之', '曽川 裕之', 6),
  ('ウェルネス', E'四条本校\n洛西口校', '山本 香澄', '濱口 美由紀', 7),
  ('管理部', '全校', '太田 恭子', '太田 恭子', 8);
