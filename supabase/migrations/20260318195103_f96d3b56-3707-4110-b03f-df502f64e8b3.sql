
-- Step 1: Drop the view that will be recreated
DROP VIEW IF EXISTS public.user_directory;

-- Step 2: Create enum
DO $$ BEGIN
  CREATE TYPE public.app_user_role AS ENUM ('admin', 'driver', 'customer', 'corporate');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Step 3: Create profiles table
CREATE TABLE public.profiles (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role app_user_role NOT NULL,
  full_name TEXT NOT NULL DEFAULT '',
  phone TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own profile"
  ON public.profiles FOR SELECT TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Admins can read all profiles"
  ON public.profiles FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin'));

CREATE POLICY "Admins can update profiles"
  ON public.profiles FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin'));

CREATE TRIGGER update_profiles_updated_at
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Step 4: Backfill
INSERT INTO public.profiles (user_id, role, full_name)
SELECT ur.user_id, 'admin'::app_user_role, COALESCE(sp.full_name, '')
FROM public.user_roles ur
LEFT JOIN public.staff_profiles sp ON sp.user_id = ur.user_id
WHERE ur.role = 'admin'
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO public.profiles (user_id, role, full_name, phone)
SELECT d.user_id, 'driver'::app_user_role,
  COALESCE(TRIM(CONCAT(d.first_name, ' ', d.last_name)), ''), d.phone
FROM public.drivers d WHERE d.user_id IS NOT NULL
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO public.profiles (user_id, role, full_name, phone)
SELECT c.user_id, 'customer'::app_user_role,
  COALESCE(TRIM(CONCAT(c.first_name, ' ', c.last_name)), ''), c.phone
FROM public.customers c WHERE c.user_id IS NOT NULL
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO public.profiles (user_id, role, full_name, phone)
SELECT cu.user_id, 'corporate'::app_user_role,
  COALESCE(TRIM(CONCAT(cu.first_name, ' ', cu.last_name)), ''), cu.phone
FROM public.corporate_users cu WHERE cu.user_id IS NOT NULL
ON CONFLICT (user_id) DO NOTHING;

-- Step 5: Signup trigger
CREATE OR REPLACE FUNCTION public.handle_new_user_profile()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $$
DECLARE
  v_app_type TEXT;
  v_role app_user_role;
  v_full_name TEXT;
BEGIN
  v_app_type := COALESCE(NEW.raw_user_meta_data ->> 'app_type', 'customer');
  CASE v_app_type
    WHEN 'admin' THEN v_role := 'admin';
    WHEN 'driver' THEN v_role := 'driver';
    WHEN 'corporate' THEN v_role := 'corporate';
    ELSE v_role := 'customer';
  END CASE;
  v_full_name := COALESCE(TRIM(CONCAT(
    COALESCE(NEW.raw_user_meta_data ->> 'first_name', ''), ' ',
    COALESCE(NEW.raw_user_meta_data ->> 'last_name', '')
  )), '');
  INSERT INTO public.profiles (user_id, role, full_name, phone)
  VALUES (NEW.id, v_role, v_full_name, NEW.raw_user_meta_data ->> 'phone')
  ON CONFLICT (user_id) DO NOTHING;
  IF v_role = 'admin' THEN
    INSERT INTO public.user_roles (user_id, role) VALUES (NEW.id, 'admin')
    ON CONFLICT (user_id, role) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_profile ON auth.users;
CREATE TRIGGER on_auth_user_created_profile
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_profile();

-- Step 6: Recreate user_directory view from profiles
CREATE VIEW public.user_directory AS
SELECT
  p.user_id, p.full_name, u.email, p.phone,
  p.role::text AS user_type,
  CASE
    WHEN p.role = 'admin' THEN COALESCE(CASE WHEN sp.is_active THEN 'active' ELSE 'inactive' END, 'active')
    WHEN p.role = 'driver' THEN COALESCE(d.approval_status, 'pending')
    WHEN p.role = 'customer' THEN 'active'
    WHEN p.role = 'corporate' THEN COALESCE(cu.status, 'active')
    ELSE 'unknown'
  END AS status,
  CASE
    WHEN p.role = 'admin' THEN (sp.id IS NOT NULL)
    WHEN p.role = 'driver' THEN (d.id IS NOT NULL)
    WHEN p.role = 'customer' THEN (c.id IS NOT NULL)
    WHEN p.role = 'corporate' THEN (cu.id IS NOT NULL)
    ELSE false
  END AS has_linked_record,
  p.created_at
FROM public.profiles p
LEFT JOIN auth.users u ON u.id = p.user_id
LEFT JOIN public.staff_profiles sp ON sp.user_id = p.user_id AND p.role = 'admin'
LEFT JOIN public.drivers d ON d.user_id = p.user_id AND p.role = 'driver'
LEFT JOIN public.customers c ON c.user_id = p.user_id AND p.role = 'customer'
LEFT JOIN public.corporate_users cu ON cu.user_id = p.user_id AND p.role = 'corporate';

-- Step 7: Update has_role to use profiles
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles WHERE user_id = _user_id AND role::text = _role::text
  )
$$;
