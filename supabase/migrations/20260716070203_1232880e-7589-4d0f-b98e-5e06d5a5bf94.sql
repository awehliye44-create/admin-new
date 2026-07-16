
-- 1. SECURITY DEFINER views → set security_invoker
ALTER VIEW public.driver_financial_summary SET (security_invoker = on);
ALTER VIEW public.driver_payout_accounts SET (security_invoker = on);

-- 2. Function search_path
ALTER FUNCTION public.payout_batch_kind_to_ledger_type(text) SET search_path = public;

-- 3. Drivers self-insert privilege escalation: force safe defaults for non-admins
CREATE OR REPLACE FUNCTION public.enforce_driver_self_insert_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Admins and service_role may set anything
  IF public.has_role(auth.uid(), 'admin'::app_role) THEN
    RETURN NEW;
  END IF;

  -- Non-admin (self-service) inserts: force pending/unapproved state
  NEW.approval_status := 'pending';
  NEW.documents_approved := false;
  NEW.payouts_enabled := false;
  NEW.is_online := false;
  NEW.is_available := false;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_drivers_enforce_self_insert_defaults ON public.drivers;
CREATE TRIGGER trg_drivers_enforce_self_insert_defaults
BEFORE INSERT ON public.drivers
FOR EACH ROW EXECUTE FUNCTION public.enforce_driver_self_insert_defaults();

-- 4. Vehicles self-insert privilege escalation: force approval_status='pending' for non-admins
CREATE OR REPLACE FUNCTION public.enforce_vehicle_self_insert_defaults()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.has_role(auth.uid(), 'admin'::app_role) THEN
    RETURN NEW;
  END IF;

  NEW.approval_status := 'pending';
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_vehicles_enforce_self_insert_defaults ON public.vehicles;
CREATE TRIGGER trg_vehicles_enforce_self_insert_defaults
BEFORE INSERT ON public.vehicles
FOR EACH ROW EXECUTE FUNCTION public.enforce_vehicle_self_insert_defaults();
