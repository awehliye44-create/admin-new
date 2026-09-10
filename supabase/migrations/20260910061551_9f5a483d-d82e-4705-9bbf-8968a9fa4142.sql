INSERT INTO public.role_page_permissions (role, page_slug, can_access)
VALUES ('super_admin', 'user-directory', true), ('admin', 'user-directory', true)
ON CONFLICT (role, page_slug) DO UPDATE SET can_access = EXCLUDED.can_access;

DROP FUNCTION IF EXISTS public.admin_user_directory();
DROP VIEW IF EXISTS public.user_directory;

CREATE OR REPLACE FUNCTION public.admin_user_directory()
RETURNS TABLE (
  user_id uuid,
  full_name text,
  email text,
  phone text,
  user_type text,
  status text,
  has_linked_record boolean,
  linked_record_id text,
  created_at timestamptz,
  last_sign_in_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    u.id AS user_id,
    COALESCE(
      NULLIF(TRIM(sp.full_name), ''),
      NULLIF(TRIM(CONCAT_WS(' ', d.first_name, d.last_name)), ''),
      NULLIF(TRIM(CONCAT_WS(' ', c.first_name, c.last_name)), ''),
      NULLIF(TRIM(CONCAT_WS(' ', cu.first_name, cu.last_name)), ''),
      NULLIF(TRIM(p.full_name), ''),
      'Unnamed user'
    ) AS full_name,
    COALESCE(u.email, d.email, cu.email) AS email,
    COALESCE(d.phone, c.phone, cu.phone, p.phone) AS phone,
    CASE
      WHEN sp.id IS NOT NULL THEN 'admin'
      WHEN d.id IS NOT NULL THEN 'driver'
      WHEN cu.id IS NOT NULL THEN 'corporate'
      WHEN c.id IS NOT NULL THEN 'customer'
      WHEN p.role IS NOT NULL THEN p.role::text
      ELSE 'unknown'
    END AS user_type,
    CASE
      WHEN sp.id IS NOT NULL THEN CASE WHEN sp.is_active THEN 'active' ELSE 'inactive' END
      WHEN d.id IS NOT NULL THEN COALESCE(d.approval_status, 'pending')
      WHEN cu.id IS NOT NULL THEN COALESCE(cu.status, 'active')
      WHEN c.id IS NOT NULL THEN 'active'
      ELSE 'profile_incomplete'
    END AS status,
    (sp.id IS NOT NULL OR d.id IS NOT NULL OR c.id IS NOT NULL OR cu.id IS NOT NULL) AS has_linked_record,
    COALESCE(sp.id::text, d.id::text, cu.id::text, c.id::text) AS linked_record_id,
    u.created_at,
    u.last_sign_in_at
  FROM auth.users u
  LEFT JOIN public.profiles p ON p.user_id = u.id
  LEFT JOIN public.staff_profiles sp ON sp.user_id = u.id
  LEFT JOIN public.drivers d ON d.user_id = u.id AND d.deleted_at IS NULL
  LEFT JOIN public.customers c ON c.user_id = u.id AND c.deleted_at IS NULL
  LEFT JOIN public.corporate_users cu ON cu.user_id = u.id
  WHERE u.deleted_at IS NULL
    AND (
      public.is_super_admin(auth.uid())
      OR public.staff_has_page_access('user-directory')
      OR public.has_role(auth.uid(), 'admin'::public.app_role)
    )
  ORDER BY u.created_at DESC;
$$;

REVOKE ALL ON FUNCTION public.admin_user_directory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.admin_user_directory() TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_user_directory() TO service_role;