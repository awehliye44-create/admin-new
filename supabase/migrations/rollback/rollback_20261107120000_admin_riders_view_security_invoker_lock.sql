-- ============================================================
-- ROLLBACK for 20261107120000_admin_riders_view_security_invoker_lock.sql
--
-- Restores the pre-fix view definition (SECURITY DEFINER / no invoker)
-- and the broad ACL that existed before this lock.
--
-- WARNING: This reintroduces the Security Advisor ERROR and the
-- authenticated/anon PII exposure. Use only for emergency revert;
-- prefer a new forward fix.
--
-- Does NOT remove this rollback's forward migration from schema_migrations.
-- ============================================================

BEGIN;

DROP VIEW IF EXISTS public.admin_riders_with_trip_stats;

CREATE VIEW public.admin_riders_with_trip_stats AS
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
WHERE c.deleted_at IS NULL;

-- Pre-fix ACL (matches baseline captured 2026-09-06)
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.admin_riders_with_trip_stats TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.admin_riders_with_trip_stats TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON TABLE public.admin_riders_with_trip_stats TO service_role;

COMMIT;
