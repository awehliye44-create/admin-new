DROP VIEW IF EXISTS public.admin_pending_customer_signups;

CREATE OR REPLACE FUNCTION public.admin_list_pending_customer_signups()
RETURNS TABLE (
  id uuid,
  user_id uuid,
  first_name text,
  last_name text,
  email text,
  phone text,
  email_verified_at timestamptz,
  phone_verified_at timestamptz,
  status text,
  signup_source text,
  expires_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  auth_email_confirmed_at timestamptz,
  auth_phone_confirmed_at timestamptz,
  record_type text,
  legacy_customer_code text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id, p.user_id, p.first_name, p.last_name, p.email, p.phone,
    p.email_verified_at, p.phone_verified_at, p.status, p.signup_source,
    p.expires_at, p.created_at, p.updated_at,
    u.email_confirmed_at, u.phone_confirmed_at,
    'pending_signup'::text, NULL::text
  FROM public.pending_customer_signups p
  JOIN auth.users u ON u.id = p.user_id
  WHERE public.has_role(auth.uid(), 'admin'::app_role)
    AND p.status = ANY (ARRAY['pending','email_verified'])
  UNION ALL
  SELECT c.id, c.user_id, c.first_name, c.last_name, u.email::text, c.phone,
    c.email_verified_at, c.phone_verified_at,
    'legacy_ghost'::text,
    COALESCE(c.customer_code, 'legacy_customer_row'::text),
    NULL::timestamptz,
    c.created_at, c.updated_at,
    u.email_confirmed_at, u.phone_confirmed_at,
    'legacy_ghost'::text, c.customer_code
  FROM public.customers c
  JOIN auth.users u ON u.id = c.user_id
  WHERE public.has_role(auth.uid(), 'admin'::app_role)
    AND c.deleted_at IS NULL
    AND (c.rider_status = 'pending_verification' OR c.email_verified IS NOT TRUE OR c.phone_verified IS NOT TRUE)
    AND NOT EXISTS (
      SELECT 1 FROM public.pending_customer_signups p2
      WHERE p2.user_id = c.user_id AND p2.status = ANY (ARRAY['pending','email_verified'])
    )
  ORDER BY 12 DESC;
$$;

REVOKE ALL ON FUNCTION public.admin_list_pending_customer_signups() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_list_pending_customer_signups() TO authenticated, service_role;