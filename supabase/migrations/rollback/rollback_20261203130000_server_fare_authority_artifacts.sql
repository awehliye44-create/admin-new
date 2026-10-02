-- Rollback for 20261203130000_server_fare_authority_artifacts.sql
--
-- ORDER: redeploy the pre-fix calculate-route, calculate-fare,
-- customer-receivable-booking-quote and create-preauth-payment-intent FIRST.
-- The fixed functions select/insert server_fare_quote_id, pricing_fingerprint,
-- route_quote_artifacts and server_fare_quotes; running this while they are
-- live makes every quote and preauth fail closed.
--
-- Payment quotes, payment sessions and trips keep their own amounts; dropping
-- the artifact tables removes pricing evidence only, never money state.

BEGIN;

CREATE OR REPLACE FUNCTION public.booking_payment_quotes_immutable_financials()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public
AS $trg$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.customer_id IS DISTINCT FROM OLD.customer_id
       OR NEW.user_id IS DISTINCT FROM OLD.user_id
       OR NEW.client_action_id IS DISTINCT FROM OLD.client_action_id
       OR NEW.service_area_id IS DISTINCT FROM OLD.service_area_id
       OR NEW.ride_category IS DISTINCT FROM OLD.ride_category
       OR NEW.route_fingerprint IS DISTINCT FROM OLD.route_fingerprint
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.trip_fare_pence IS DISTINCT FROM OLD.trip_fare_pence
       OR NEW.buffer_pence IS DISTINCT FROM OLD.buffer_pence
       OR NEW.receivable_pence IS DISTINCT FROM OLD.receivable_pence
       OR NEW.total_authorisation_pence IS DISTINCT FROM OLD.total_authorisation_pence
       OR NEW.fold_eligible IS DISTINCT FROM OLD.fold_eligible
       OR NEW.consent_version IS DISTINCT FROM OLD.consent_version
       OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
    THEN
      RAISE EXCEPTION 'booking_payment_quotes financial fields are immutable after issuance'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$trg$;

ALTER TABLE public.booking_payment_quotes
  DROP COLUMN IF EXISTS server_fare_quote_id,
  DROP COLUMN IF EXISTS pricing_fingerprint;

DROP TABLE IF EXISTS public.server_fare_quotes;
DROP TABLE IF EXISTS public.route_quote_artifacts;
DROP FUNCTION IF EXISTS public.server_fare_artifacts_immutable();

COMMIT;
