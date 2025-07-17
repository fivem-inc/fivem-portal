-- Add admin policy for profile updates
-- Allow admin to update any user's profile
create policy "Admins can update any profile."
  on profiles for update
  using (auth.uid() in (select id from profiles where email = 'fivem.kyoto@gmail.com'));