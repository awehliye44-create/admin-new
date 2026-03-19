
-- 1. Fix recursive RLS policies on profiles table
DROP POLICY IF EXISTS "Admins can read all profiles" ON public.profiles;
DROP POLICY IF EXISTS "Admins can update profiles" ON public.profiles;

-- Use has_role() (security definer) to avoid infinite recursion
CREATE POLICY "Admins can read all profiles" ON public.profiles
  FOR SELECT USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update profiles" ON public.profiles
  FOR UPDATE USING (public.has_role(auth.uid(), 'admin'));

-- 2. Ensure admin@onecab.net has a staff_profiles entry as super_admin
INSERT INTO public.staff_profiles (user_id, full_name, role, is_active)
VALUES (
  '0c3ac284-72fd-4cf7-8f0e-fb520f13a2e6',
  'Admin',
  'super_admin',
  true
)
ON CONFLICT (user_id) DO UPDATE SET role = 'super_admin', is_active = true;
