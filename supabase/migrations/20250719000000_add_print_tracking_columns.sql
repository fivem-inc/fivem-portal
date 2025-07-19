-- 印刷履歴管理用のカラムを追加
ALTER TABLE expenses 
ADD COLUMN printed_at TIMESTAMP WITH TIME ZONE,
ADD COLUMN printed_by UUID REFERENCES auth.users(id);

-- インデックスを追加（検索パフォーマンス向上）
CREATE INDEX idx_expenses_printed_at ON expenses(printed_at);
CREATE INDEX idx_expenses_printed_by ON expenses(printed_by);

-- コメント追加
COMMENT ON COLUMN expenses.printed_at IS '最後に印刷された日時';
COMMENT ON COLUMN expenses.printed_by IS '印刷した管理者のユーザーID';