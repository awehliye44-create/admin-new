-- 1) Revoke anon EXECUTE on SECURITY DEFINER functions, except public pre-auth allowlist
DO $$
DECLARE
  r record;
  allowlist text[] := ARRAY[
    'list_driver_signup_countries',
    'get_driver_signup_location_options',
    'get_driver_signup_service_areas',
    'validate_driver_signup_region_service_areas',
    'driver_signup_country_label',
    'check_email_available_for_change',
    'check_phone_available_for_change',
    'check_identity_exists',
    'upsert_pending_customer_signup'
  ];
BEGIN
  FOR r IN
    SELECT p.oid,
           p.oid::regprocedure::text AS sig,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_ok,
           has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_ok
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND has_function_privilege('anon', p.oid, 'EXECUTE')
      AND NOT (p.proname = ANY (allowlist))
  LOOP
    -- Preserve existing privileges for real roles before dropping PUBLIC/anon
    IF r.auth_ok THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', r.sig);
    END IF;
    IF r.svc_ok THEN
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', r.sig);
    END IF;
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', r.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', r.sig);
  END LOOP;
END $$;

-- 2) Policies for RLS-enabled tables that had none
-- Credential vaults: service_role only, no policies for anon/authenticated
REVOKE ALL ON public.integration_secret_vault FROM anon, authenticated;
REVOKE ALL ON public.payment_provider_vault FROM anon, authenticated;
GRANT ALL ON public.integration_secret_vault TO service_role;
GRANT ALL ON public.payment_provider_vault TO service_role;

DROP POLICY IF EXISTS "No client access to integration_secret_vault" ON public.integration_secret_vault;
CREATE POLICY "No client access to integration_secret_vault"
  ON public.integration_secret_vault FOR ALL TO authenticated, anon
  USING (false) WITH CHECK (false);

DROP POLICY IF EXISTS "No client access to payment_provider_vault" ON public.payment_provider_vault;
CREATE POLICY "No client access to payment_provider_vault"
  ON public.payment_provider_vault FOR ALL TO authenticated, anon
  USING (false) WITH CHECK (false);

-- Internal operational tables: service_role writes, admin reads
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['dispatch_jobs','trip_route_cache','trip_state_violations']
  LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('DROP POLICY IF EXISTS "Admins can read %s" ON public.%I', t, t);
    EXECUTE format('CREATE POLICY "Admins can read %s" ON public.%I FOR SELECT TO authenticated USING (public.has_role(auth.uid(), ''admin''::app_role))', t, t);
  END LOOP;
END $$;