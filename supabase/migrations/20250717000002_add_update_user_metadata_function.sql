-- Create function to update user metadata (admin only)
CREATE OR REPLACE FUNCTION public.update_user_metadata(user_id UUID, metadata JSONB)
RETURNS VOID AS $$
BEGIN
  -- Check if current user is admin
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles 
    WHERE id = auth.uid() AND email = 'fivem.kyoto@gmail.com'
  ) THEN
    RAISE EXCEPTION 'Access denied. Admin privileges required.';
  END IF;
  
  -- Update user metadata
  UPDATE auth.users 
  SET raw_user_meta_data = COALESCE(raw_user_meta_data, '{}'::jsonb) || metadata
  WHERE id = user_id;
  
  -- Also update profiles table for consistency
  UPDATE public.profiles 
  SET name = metadata->>'name'
  WHERE id = user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;