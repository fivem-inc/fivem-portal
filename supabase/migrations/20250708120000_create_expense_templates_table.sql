
-- Create expense_templates table
CREATE TABLE expense_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  template_name TEXT NOT NULL,
  expenses_data JSONB, -- 複数の区間を保存するためのJSONB型
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Enable Row Level Security (RLS)
ALTER TABLE expense_templates ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Users can view their own templates
CREATE POLICY "Users can view their own expense templates."
  ON expense_templates FOR SELECT
  USING (auth.uid() = user_id);

-- RLS Policy: Users can insert their own templates
CREATE POLICY "Users can insert their own expense templates."
  ON expense_templates FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- RLS Policy: Users can update their own templates
CREATE POLICY "Users can update their own expense templates."
  ON expense_templates FOR UPDATE
  USING (auth.uid() = user_id);

-- RLS Policy: Users can delete their own templates
CREATE POLICY "Users can delete their own expense templates."
  ON expense_templates FOR DELETE
  USING (auth.uid() = user_id);
