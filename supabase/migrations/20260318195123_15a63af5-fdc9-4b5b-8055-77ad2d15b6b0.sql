
-- Fix security: make user_directory SECURITY INVOKER and avoid exposing auth.users directly
-- Drop and recreate with SECURITY INVOKER + no direct auth.users email exposure
DROP VIEW IF EXISTS public.user_directory;

CREATE VIEW public.user_directory WITH (security_invoker = true) AS
SELECT
  p.user_id, p.full_name, p.phone,
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
  p.created_at,
  COALESCE(
    CASE WHEN p.role = 'driver' THEN d.email END,
    CASE WHEN p.role = 'corporate' THEN cu.email END,
    sp.username
  ) AS email
FROM public.profiles p
LEFT JOIN public.staff_profiles sp ON sp.user_id = p.user_id AND p.role = 'admin'
LEFT JOIN public.drivers d ON d.user_id = p.user_id AND p.role = 'driver'
LEFT JOIN public.customers c ON c.user_id = p.user_id AND p.role = 'customer'
LEFT JOIN public.corporate_users cu ON cu.user_id = p.user_id AND p.role = 'corporate';

-- Update RLS on profiles to use profiles itself (self-referencing for admin check)
DROP POLICY IF EXISTS "Admins can read all profiles" ON public.profiles;
DROP POLICY IF EXISTS "Admins can update profiles" ON public.profiles;

CREATE POLICY "Admins can read all profiles"
  ON public.profiles FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = auth.uid() AND p.role = 'admin'));

CREATE POLICY "Admins can update profiles"
  ON public.profiles FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = auth.uid() AND p.role = 'admin'));
