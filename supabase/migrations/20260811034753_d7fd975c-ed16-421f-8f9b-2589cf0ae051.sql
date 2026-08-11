-- 1) Security Definer Views -> security invoker
ALTER VIEW public.available_scheduled_jobs SET (security_invoker = on);
ALTER VIEW public.driver_financial_summary SET (security_invoker = on);

-- 2) Function search_path pinning
ALTER FUNCTION public.document_type_renewal_open_days(integer[]) SET search_path = public;
ALTER FUNCTION public.resolve_booking_customer_payable_pence(jsonb, jsonb, integer, integer) SET search_path = public;

-- 3) Fix tautological driver-scoping policy
DROP POLICY IF EXISTS "Drivers read own SA identity verification settings" ON public.service_area_identity_verification_settings;

CREATE POLICY "Drivers read own SA identity verification settings"
ON public.service_area_identity_verification_settings
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.drivers d
    WHERE d.user_id = auth.uid()
      AND d.deleted_at IS NULL
      AND d.service_area_id = service_area_identity_verification_settings.service_area_id
  )
);