-- ============================================================
-- admin_riders_with_trip_stats — SECURITY INVOKER + admin gate
--
-- Fixes Security Advisor ERROR security_definer_view:
--   View previously ran as owner (postgres) and bypassed RLS on
--   customers/trips while SELECT was granted broadly (incl. anon).
--
-- Required end state:
--   - Same columns/types as production reshape (identity columns included)
--   - security_invoker = true
--   - Fail-closed row gate: has_role(admin) OR auth.role() = service_role
--   - PUBLIC/anon: no privileges
--   - authenticated / service_role: SELECT only
--
-- Does NOT modify customers/trips RLS policies.
-- Does NOT address other Security Advisor warnings.
-- ============================================================

BEGIN;

DROP VIEW IF EXISTS public.admin_riders_with_trip_stats;

CREATE VIEW public.admin_riders_with_trip_stats
WITH (security_invoker = true)
AS
SELECT
  c.id,
  c.user_id,
  c.customer_code,
  c.first_name,
  c.last_name,
  c.phone,
  public.admin_get_user_email(c.user_id) AS email,
  c.created_at,
  c.updated_at,
  c.rider_status,
  c.email_verified,
  c.phone_verified,
  c.identity_verified_at,
  c.identity_provider,
  c.name_edit_locked,
  c.name_unlocked_at,
  COALESCE(ts.trip_count, 0) AS trip_count,
  ts.last_trip_at
FROM public.customers c
LEFT JOIN (
  SELECT
    t.passenger_id,
    count(*)::integer AS trip_count,
    max(t.created_at) AS last_trip_at
  FROM public.trips t
  WHERE t.passenger_id IS NOT NULL
  GROUP BY t.passenger_id
) ts ON ts.passenger_id = c.id
WHERE c.deleted_at IS NULL
  AND (
    public.has_role(auth.uid(), 'admin'::public.app_role)
    OR auth.role() = 'service_role'
  );

COMMENT ON VIEW public.admin_riders_with_trip_stats IS
  'Admin riders list with trip_count/last_trip_at. SECURITY INVOKER + admin/service_role row gate. Do not recreate without security_invoker = true.';

-- Strip default-privilege over-grants, then grant SELECT only.
REVOKE ALL ON TABLE public.admin_riders_with_trip_stats FROM PUBLIC;
REVOKE ALL ON TABLE public.admin_riders_with_trip_stats FROM anon;
REVOKE ALL ON TABLE public.admin_riders_with_trip_stats FROM authenticated;
REVOKE ALL ON TABLE public.admin_riders_with_trip_stats FROM service_role;

GRANT SELECT ON TABLE public.admin_riders_with_trip_stats TO authenticated;
GRANT SELECT ON TABLE public.admin_riders_with_trip_stats TO service_role;

COMMIT;
