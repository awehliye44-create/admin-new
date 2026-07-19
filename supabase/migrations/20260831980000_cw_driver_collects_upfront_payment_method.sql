-- P0: DRIVER_COLLECTED_COMMISSION_WALLET must not use legacy cash,
-- and must not be blocked by digital-only payment_method enforcement.
-- Canonical trip payment_method for this model: driver_collects_upfront

CREATE OR REPLACE FUNCTION public.trip_row_is_commission_wallet_driver_collected(p_row public.trips)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_financial_model text;
  v_cw_enabled boolean;
BEGIN
  IF UPPER(COALESCE(p_row.financial_model::text, '')) = 'DRIVER_COLLECTED_COMMISSION_WALLET'
     AND COALESCE(p_row.commission_wallet_enabled, false) IS TRUE THEN
    RETURN TRUE;
  END IF;

  IF p_row.service_area_id IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT sa.financial_model::text, sa.commission_wallet_enabled
    INTO v_financial_model, v_cw_enabled
  FROM public.service_areas sa
  WHERE sa.id = p_row.service_area_id;

  RETURN UPPER(COALESCE(v_financial_model, '')) = 'DRIVER_COLLECTED_COMMISSION_WALLET'
     AND COALESCE(v_cw_enabled, false) IS TRUE;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_digital_only_payment_method()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_method text := lower(COALESCE(NEW.payment_method, ''));
BEGIN
  IF NEW.payment_method IS NULL THEN
    RETURN NEW;
  END IF;

  -- Canonical Commission Wallet driver-collected path (NOT legacy cash).
  IF v_method = 'driver_collects_upfront' THEN
    IF public.trip_row_is_commission_wallet_driver_collected(NEW) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION
      'payment_method driver_collects_upfront is only valid for DRIVER_COLLECTED_COMMISSION_WALLET service areas.'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Legacy cash: only allowed when SA/trip is CW (compat); prefer driver_collects_upfront.
  IF v_method = 'cash' THEN
    IF public.trip_row_is_commission_wallet_driver_collected(NEW) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION
      'Cash payment method is no longer supported. ONECAB is a digital-only platform.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_method NOT IN (
    'card', 'wallet', 'apple_pay', 'google_pay', 'revolut', 'corporate_account'
  ) THEN
    RAISE EXCEPTION
      'ONECAB is digital-only: payment_method "%" is not allowed for new trips. Supported methods: card, wallet, apple_pay, google_pay, revolut, corporate_account, driver_collects_upfront.',
      NEW.payment_method
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_digital_only_payment_method() IS
  'PLATFORM_COLLECTED: digital methods only. DRIVER_COLLECTED_COMMISSION_WALLET: allows driver_collects_upfront (not platform cash).';
