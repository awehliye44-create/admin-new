-- 1) Enable RLS + admin-only read on internal tables
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['dispatch_intent_outbox','driver_cancel_rematch_audit','driver_cancel_rematch_idempotency','invoice_delivery_attempts','invoice_smoke_runs','payment_webhook_events']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I NO FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
    EXECUTE format('DROP POLICY IF EXISTS "Admins can read %s" ON public.%I', t, t);
    EXECUTE format('CREATE POLICY "Admins can read %s" ON public.%I FOR SELECT TO authenticated USING (public.has_role(auth.uid(), ''admin''::app_role))', t, t);
  END LOOP;
END $$;

-- 2) Security invoker views
ALTER VIEW public.available_scheduled_jobs SET (security_invoker = on);
ALTER VIEW public.driver_document_compliance_ssot SET (security_invoker = on);

-- 3) Pin search_path on remaining functions
ALTER FUNCTION public.driver_document_primary_attachment_locator(uuid) SET search_path = public;
ALTER FUNCTION public.driver_document_storage_path_from_locator(text) SET search_path = public;
ALTER FUNCTION public.driver_location_state(boolean, timestamp with time zone, timestamp with time zone, double precision, timestamp with time zone) SET search_path = public;
ALTER FUNCTION public.driver_location_thresholds() SET search_path = public;
ALTER FUNCTION public.enforce_scheduled_trip_lifecycle() SET search_path = public;
ALTER FUNCTION public.tg_driver_identity_verifications_updated_at() SET search_path = public;
ALTER FUNCTION public.trip_status_is_live_trackable(text) SET search_path = public;