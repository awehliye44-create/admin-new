-- Rollback: remove BONUS from payout-eligible ledger types / Available.
-- Restores pre-correction allowlists (TRIP_EARNING_NET + tips + DRIVER_COMPENSATION_CREDIT).
-- Does not rewrite driver_wallet_eligibility_balances body — re-apply the prior
-- financial_resilience_hardening definition if Available must exclude BONUS again.

BEGIN;

CREATE OR REPLACE FUNCTION public.payout_ledger_type_is_payout_eligible(p_type text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO pg_catalog, public
AS $$
  SELECT upper(btrim(coalesce(p_type, ''))) IN (
    'TRIP_EARNING_NET',
    'DRIVER_COMPENSATION_CREDIT',
    'DRIVER_TIP_CREDIT',
    'TIP_CREDIT'
  );
$$;

COMMIT;
