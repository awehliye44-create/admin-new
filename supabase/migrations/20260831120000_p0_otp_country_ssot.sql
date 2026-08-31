-- P0: OTP country allow-list — server-authoritative, no anon/public table reads.
-- Rollback (manual only, NOT a migration): supabase/rollback/p0_security_hardening_rollback_20260831.sql

-- Narrow read-only RPC for signup / phone UX (country_code + country_name only).
CREATE OR REPLACE FUNCTION public.list_enabled_otp_country_codes()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'country_code', c.country_code,
        'country_name', c.country_name
      )
      ORDER BY c.country_name
    ),
    '[]'::jsonb
  )
  FROM public.otp_allowed_countries c
  WHERE c.is_enabled = true;
$$;

COMMENT ON FUNCTION public.list_enabled_otp_country_codes() IS
  'Public-safe enabled OTP countries (code + name only). Replaces direct anon/authenticated SELECT on otp_allowed_countries.';

REVOKE ALL ON FUNCTION public.list_enabled_otp_country_codes() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_enabled_otp_country_codes() TO anon, authenticated, service_role;

-- Remove world-readable table policy; admin CRUD policies remain for authenticated admins.
DROP POLICY IF EXISTS "Anyone can read enabled OTP countries" ON public.otp_allowed_countries;

REVOKE ALL ON TABLE public.otp_allowed_countries FROM anon;
REVOKE ALL ON TABLE public.otp_allowed_countries FROM PUBLIC;

-- Admins manage via existing authenticated admin policies; service_role for Edge Functions.
GRANT SELECT ON TABLE public.otp_allowed_countries TO service_role;
