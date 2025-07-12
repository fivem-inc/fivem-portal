-- profiles table
create table profiles (
  id uuid references auth.users on delete cascade,
  email text unique,
  primary key (id)
);

-- expenses table
create type expense_status as enum ('pending', 'approved', 'rejected');

create table expenses (
  id uuid primary key default uuid_generate_v4(),
  user_id uuid references profiles on delete cascade,
  created_at timestamp with time zone default now(),
  expenses_data jsonb,
  status expense_status default 'pending',
  approved_at timestamp with time zone,
  rejected_at timestamp with time zone
);

-- RLS for profiles
alter table profiles enable row level security;

create policy "Public profiles are viewable by everyone."
  on profiles for select
  using (true);

create policy "Users can insert their own profile."
  on profiles for insert
  with check (auth.uid() = id);

create policy "Users can update their own profile."
  on profiles for update
  using (auth.uid() = id);

-- RLS for expenses
alter table expenses enable row level security;

create policy "Users can view their own expenses."
  on expenses for select
  using (auth.uid() = user_id);

create policy "Admins can view all expenses."
  on expenses for select
  using (auth.uid() in (select id from profiles where email = 'fivem.kyoto@gmail.com'));

create policy "Users can insert their own expenses."
  on expenses for insert
  with check (auth.uid() = user_id);

create policy "Admins can update any expense."
  on expenses for update
  using (auth.uid() in (select id from profiles where email = 'fivem.kyoto@gmail.com'));

-- Function to update profile email on auth.users email change
CREATE OR REPLACE FUNCTION public.handle_user_email_update()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE public.profiles
  SET email = NEW.email
  WHERE id = NEW.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to call the function on auth.users email update
CREATE TRIGGER on_auth_user_email_update
AFTER UPDATE OF email ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.handle_user_email_update();

-- Function to create profile on new auth.users signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger to call the function on new auth.users signup
CREATE TRIGGER on_auth_user_created
AFTER INSERT ON auth.users
FOR EACH ROW
EXECUTE FUNCTION public.handle_new_user();