-- Fix: enforce_driver_self_insert_defaults referenced drivers.is_available
-- which no longer exists in production, breaking non-admin driver inserts
-- (including service-role start-driver-application where auth.uid() is null).

CREATE OR REPLACE FUNCTION public.enforce_driver_self_insert_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Admins may set anything. Service-role inserts have auth.uid() null
  -- and must also receive safe application defaults.
  IF auth.uid() IS NOT NULL AND public.has_role(auth.uid(), 'admin'::app_role) THEN
    RETURN NEW;
  END IF;

  NEW.approval_status := 'pending';
  NEW.documents_approved := false;
  NEW.payouts_enabled := false;
  NEW.is_online := false;
  NEW.driver_online_intent := false;
  IF NEW.onboarding_complete IS NULL THEN
    NEW.onboarding_complete := false;
  END IF;
  RETURN NEW;
END;
$$;
