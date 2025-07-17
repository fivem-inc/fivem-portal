-- Add rejected_reason column to expenses table
ALTER TABLE expenses
ADD COLUMN rejected_reason TEXT;