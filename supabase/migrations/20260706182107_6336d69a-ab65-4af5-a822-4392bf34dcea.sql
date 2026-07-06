-- Digital-only enforcement: ONECAB no longer allows cash on new trips.
-- Historical cash trips remain intact and readable; only new INSERTs are blocked.

CREATE OR REPLACE FUNCTION public.enforce_digital_only_payment_method()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.payment_method IS NOT NULL
     AND lower(NEW.payment_method) NOT IN (
       'card', 'wallet', 'apple_pay', 'google_pay', 'revolut', 'corporate_account'
     )
  THEN
    RAISE EXCEPTION 'ONECAB is digital-only: payment_method "%" is not allowed for new trips. Supported methods: card, wallet, apple_pay, google_pay, revolut, corporate_account.', NEW.payment_method
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_trips_digital_only ON public.trips;
CREATE TRIGGER trg_trips_digital_only
  BEFORE INSERT ON public.trips
  FOR EACH ROW EXECUTE FUNCTION public.enforce_digital_only_payment_method();

-- Also block cash on UPDATE if someone tries to switch a live trip to cash.
DROP TRIGGER IF EXISTS trg_trips_digital_only_update ON public.trips;
CREATE TRIGGER trg_trips_digital_only_update
  BEFORE UPDATE OF payment_method ON public.trips
  FOR EACH ROW
  WHEN (NEW.payment_method IS DISTINCT FROM OLD.payment_method)
  EXECUTE FUNCTION public.enforce_digital_only_payment_method();