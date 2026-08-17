-- Step A (nullable): stamp financial_model on trip insert when the service
-- area already has a pairing. Column stays nullable. Do NOT apply 80100
-- NOT NULL until new Milton Keynes / Banadir bookings are verified.
-- Unpaired service areas (Kampala until 80100) and missing service_area_id
-- are left null — this trigger must not fail-close existing writers.
-- Covers create-trip-after-payment, webhook finalize_paid_booking_session,
-- Manual Trip, and lost-property return trips.

CREATE OR REPLACE FUNCTION public.stamp_trip_financial_model_on_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sa public.service_areas%ROWTYPE;
BEGIN
  IF NEW.service_area_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_sa FROM public.service_areas WHERE id = NEW.service_area_id;
  IF NOT FOUND OR v_sa.financial_model IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.financial_model IS NULL THEN
    NEW.financial_model := v_sa.financial_model;
    NEW.payment_collection_model := COALESCE(NEW.payment_collection_model, v_sa.customer_payment_policy);
    NEW.commission_wallet_enabled := COALESCE(NEW.commission_wallet_enabled, v_sa.commission_wallet_enabled);
  END IF;

  IF NEW.financial_model IS DISTINCT FROM v_sa.financial_model THEN
    RAISE EXCEPTION
      'FINANCIAL_MODEL_VIOLATION: trip financial_model % does not match service area % at insert',
      NEW.financial_model, v_sa.financial_model
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.financial_model = 'PLATFORM_COLLECTED' THEN
    NEW.payment_collection_model := 'PLATFORM_PREPAID';
    NEW.commission_wallet_enabled := false;
  ELSIF NEW.financial_model = 'DRIVER_COLLECTED_COMMISSION_WALLET' THEN
    NEW.payment_collection_model := 'DRIVER_COLLECTS_UPFRONT';
    NEW.commission_wallet_enabled := true;
  ELSE
    RAISE EXCEPTION 'FINANCIAL_MODEL_VIOLATION: invalid financial_model %', NEW.financial_model
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_stamp_trip_financial_model_on_insert ON public.trips;
DROP TRIGGER IF EXISTS trg_00_stamp_trip_financial_model_on_insert ON public.trips;
CREATE TRIGGER trg_00_stamp_trip_financial_model_on_insert
  BEFORE INSERT ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_trip_financial_model_on_insert();
