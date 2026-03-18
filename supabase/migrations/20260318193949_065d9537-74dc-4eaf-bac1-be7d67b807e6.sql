
CREATE OR REPLACE VIEW public.user_directory AS

-- Admins (from user_roles table)
SELECT 
  ur.user_id,
  COALESCE(sp.full_name, 'Admin User') AS full_name,
  NULL::text AS email,
  NULL::text AS phone,
  'admin'::text AS user_type,
  CASE WHEN sp.is_active IS NOT FALSE THEN 'active' ELSE 'inactive' END AS status,
  sp.id IS NOT NULL AS has_linked_record,
  ur.created_at,
  NULL::timestamptz AS last_sign_in_at
FROM public.user_roles ur
LEFT JOIN public.staff_profiles sp ON sp.user_id = ur.user_id
WHERE ur.role = 'admin'

UNION ALL

-- Drivers
SELECT
  d.user_id,
  COALESCE(d.first_name || ' ' || d.last_name, d.first_name, 'Driver') AS full_name,
  d.email,
  d.phone,
  'driver'::text AS user_type,
  d.approval_status AS status,
  true AS has_linked_record,
  d.created_at,
  NULL::timestamptz AS last_sign_in_at
FROM public.drivers d

UNION ALL

-- Customers
SELECT
  c.user_id,
  COALESCE(NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), ''), 'Customer') AS full_name,
  NULL::text AS email,
  c.phone,
  'customer'::text AS user_type,
  'active'::text AS status,
  true AS has_linked_record,
  c.created_at,
  NULL::timestamptz AS last_sign_in_at
FROM public.customers c

UNION ALL

-- Corporate users
SELECT
  cu.user_id,
  cu.first_name || ' ' || cu.last_name AS full_name,
  cu.email,
  cu.phone,
  'corporate'::text AS user_type,
  COALESCE(cu.status, 'active') AS status,
  true AS has_linked_record,
  cu.created_at,
  NULL::timestamptz AS last_sign_in_at
FROM public.corporate_users cu
WHERE cu.user_id IS NOT NULL;

GRANT SELECT ON public.user_directory TO authenticated;
