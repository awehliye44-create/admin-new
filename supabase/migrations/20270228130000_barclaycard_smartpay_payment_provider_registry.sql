-- P0: Register Barclaycard Smartpay on Payment Providers (configuration readiness only).
-- No booking/payout adapters, credential schemas, or live enablement until official
-- merchant documentation + explicit production approval.
-- Revolut remains the live customer payment and driver payout provider.
--
-- Backend enforcement (independent of Admin UI):
-- 1) Adapter factory + booking/payout LIVE_* sets remain Revolut-only (no Smartpay execution path).
-- 2) Trigger blocks enable/primary for barclaycard_smartpay (incl. direct SQL).
-- 3) Service-area assignment rejects providers with supports_customer/driver = false
--    (Barclaycard seeds both false), so UI bypass / RPC / direct UPDATE cannot assign it.

INSERT INTO public.payment_provider_configs (
  provider,
  display_name,
  environment,
  status,
  is_enabled,
  is_primary,
  supports_customer_payments,
  supports_driver_payouts
)
VALUES (
  'barclaycard_smartpay',
  'Barclaycard Smartpay',
  'test',
  'not_configured',
  false,
  false,
  false,
  false
)
ON CONFLICT (provider) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  environment = 'test',
  status = 'not_configured',
  is_enabled = false,
  is_primary = false,
  supports_customer_payments = false,
  supports_driver_payouts = false;

-- Force closed even if a malformed/stale row existed before this migration.
UPDATE public.payment_provider_configs
SET
  display_name = 'Barclaycard Smartpay',
  environment = 'test',
  status = 'not_configured',
  is_enabled = false,
  is_primary = false,
  supports_customer_payments = false,
  supports_driver_payouts = false
WHERE provider = 'barclaycard_smartpay';

-- Prevent enable/primary (and keep supports closed) for the Smartpay readiness stub.
CREATE OR REPLACE FUNCTION public.enforce_barclaycard_smartpay_readiness_stub()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.provider = 'barclaycard_smartpay' THEN
    IF NEW.is_enabled IS TRUE OR NEW.is_primary IS TRUE THEN
      RAISE EXCEPTION 'barclaycard_smartpay_not_ready'
        USING ERRCODE = 'check_violation',
              MESSAGE = 'Barclaycard Smartpay cannot be enabled or set primary until booking/payout adapters and merchant approval are complete';
    END IF;
    NEW.supports_customer_payments := false;
    NEW.supports_driver_payouts := false;
    IF NEW.environment IS NULL OR btrim(NEW.environment) = '' THEN
      NEW.environment := 'test';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_payment_provider_configs_barclaycard_readiness
  ON public.payment_provider_configs;
CREATE TRIGGER tr_payment_provider_configs_barclaycard_readiness
  BEFORE INSERT OR UPDATE ON public.payment_provider_configs
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_barclaycard_smartpay_readiness_stub();

-- Keep single-provider mirrors + reject unassignable providers (supports flags closed).
CREATE OR REPLACE FUNCTION public.sync_service_area_payment_provider()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_provider text;
  v_supports_customer boolean;
  v_supports_driver boolean;
BEGIN
  v_provider := COALESCE(
    NEW.payment_provider,
    NEW.customer_payment_gateway,
    NEW.driver_payout_gateway
  );

  IF v_provider IS NOT NULL THEN
    SELECT c.supports_customer_payments, c.supports_driver_payouts
      INTO v_supports_customer, v_supports_driver
    FROM public.payment_provider_configs c
    WHERE c.provider = v_provider;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'payment_provider_unknown:%', v_provider
        USING ERRCODE = 'foreign_key_violation';
    END IF;

    IF v_supports_customer IS DISTINCT FROM true
       OR v_supports_driver IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'payment_provider_not_assignable:%', v_provider
        USING ERRCODE = 'check_violation',
              MESSAGE = format(
                'Provider %s cannot be assigned to a service area until customer payment and driver payout supports are enabled',
                v_provider
              );
    END IF;
  END IF;

  NEW.payment_provider := v_provider;
  NEW.customer_payment_gateway := v_provider;
  NEW.driver_payout_gateway := v_provider;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.sync_service_area_payment_provider() SET search_path = public;
ALTER FUNCTION public.enforce_barclaycard_smartpay_readiness_stub() SET search_path = public;

DROP TRIGGER IF EXISTS tr_service_areas_sync_payment_provider ON public.service_areas;
CREATE TRIGGER tr_service_areas_sync_payment_provider
  BEFORE INSERT OR UPDATE OF payment_provider, customer_payment_gateway, driver_payout_gateway
  ON public.service_areas
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_service_area_payment_provider();
