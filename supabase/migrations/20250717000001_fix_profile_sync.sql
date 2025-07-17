-- Fix profile creation to sync user_metadata name
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, name)
  VALUES (NEW.id, NEW.email, NEW.raw_user_meta_data->>'name');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Update existing profiles to sync name from user_metadata
UPDATE public.profiles 
SET name = (
  SELECT raw_user_meta_data->>'name' 
  FROM auth.users 
  WHERE auth.users.id = profiles.id
)
WHERE name IS NULL;