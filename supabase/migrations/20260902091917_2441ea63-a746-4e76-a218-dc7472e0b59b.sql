DROP VIEW IF EXISTS public.admin_pending_customer_signups;

CREATE VIEW public.admin_pending_customer_signups
WITH (security_barrier = true) AS
 SELECT p.id, p.user_id, p.first_name, p.last_name, p.email, p.phone,
    p.email_verified_at, p.phone_verified_at, p.status, p.signup_source,
    p.expires_at, p.created_at, p.updated_at,
    u.email_confirmed_at AS auth_email_confirmed_at,
    u.phone_confirmed_at AS auth_phone_confirmed_at,
    'pending_signup'::text AS record_type,
    NULL::text AS legacy_customer_code
   FROM public.pending_customer_signups p
     JOIN auth.users u ON u.id = p.user_id
  WHERE public.has_role(auth.uid(), 'admin'::app_role)
    AND p.status = ANY (ARRAY['pending'::text, 'email_verified'::text])
UNION ALL
 SELECT c.id, c.user_id, c.first_name, c.last_name, u.email, c.phone,
    c.email_verified_at, c.phone_verified_at,
    'legacy_ghost'::text AS status,
    COALESCE(c.customer_code, 'legacy_customer_row'::text) AS signup_source,
    NULL::timestamp with time zone AS expires_at,
    c.created_at, c.updated_at,
    u.email_confirmed_at AS auth_email_confirmed_at,
    u.phone_confirmed_at AS auth_phone_confirmed_at,
    'legacy_ghost'::text AS record_type,
    c.customer_code AS legacy_customer_code
   FROM public.customers c
     JOIN auth.users u ON u.id = c.user_id
  WHERE public.has_role(auth.uid(), 'admin'::app_role)
    AND c.deleted_at IS NULL
    AND (c.rider_status = 'pending_verification'::text OR c.email_verified IS NOT TRUE OR c.phone_verified IS NOT TRUE)
    AND NOT EXISTS (
      SELECT 1 FROM public.pending_customer_signups p2
      WHERE p2.user_id = c.user_id AND p2.status = ANY (ARRAY['pending'::text, 'email_verified'::text])
    );

GRANT SELECT ON public.admin_pending_customer_signups TO authenticated;
GRANT SELECT ON public.admin_pending_customer_signups TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.pending_customer_signups TO authenticated;
GRANT ALL ON public.pending_customer_signups TO service_role;