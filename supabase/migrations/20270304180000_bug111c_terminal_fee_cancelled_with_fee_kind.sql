-- #111C — Unified terminal fee policy: CANCELLED_WITH_FEE is its own chargeable
-- terminal kind (OTHER_CANCELLATION_FEE), never LATE / ARRIVAL / NO_SHOW.
--
-- Driver net = provider-confirmed capture − ACTUAL provider fee, commission 0.
-- Eligibility in driver_wallet_eligibility_balances still requires the
-- TRIP_EARNING_NET amount to equal capture − ACTUAL fee (v_canonical), so a
-- historical CANCELLED_WITH_FEE TEN posted as capture − commission stays
-- ineligible. This migration only changes classification; it credits nothing
-- and rewrites no ledger / trip rows (historical remediation is on HOLD).
--
-- Mirror of terminalOutcomeKindSSOT.resolveTerminalOutcomeKind.

BEGIN;

CREATE OR REPLACE FUNCTION public.trip_chargeable_terminal_outcome_kind(
  p_financial_outcome text,
  p_status text,
  p_payment_status text,
  p_no_show_charge_pence integer
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'pg_catalog'
AS $function$
  -- Mirror of terminalOutcomeKindSSOT.resolveTerminalOutcomeKind.
  -- #111C: CANCELLED_WITH_FEE returns its own kind (never LATE/ARRIVAL/NO_SHOW).
  -- Arrival stamps alone do not qualify.
  SELECT CASE
    WHEN upper(COALESCE(p_financial_outcome, '')) IN ('COMPLETED', 'CANCELLED_NO_FEE')
      THEN NULL
    WHEN upper(COALESCE(p_financial_outcome, '')) = 'CANCELLED_WITH_FEE'
      THEN 'CANCELLED_WITH_FEE'
    WHEN upper(COALESCE(p_financial_outcome, '')) = 'ARRIVAL_CANCELLATION'
      THEN 'ARRIVAL_CANCELLATION'
    WHEN upper(COALESCE(p_financial_outcome, '')) = 'NO_SHOW'
      OR lower(COALESCE(p_status, '')) = 'no_show'
      THEN 'NO_SHOW'
    WHEN upper(COALESCE(p_financial_outcome, '')) = 'LATE_PASSENGER_CANCELLATION'
      THEN 'LATE_PASSENGER_CANCELLATION'
    WHEN lower(COALESCE(p_payment_status, '')) = 'fee_pending_settlement'
      AND (COALESCE(p_no_show_charge_pence, 0) > 0 OR lower(COALESCE(p_status, '')) = 'no_show')
      THEN 'NO_SHOW'
    WHEN strpos(lower(COALESCE(p_payment_status, '')), 'no_show') > 0
      AND COALESCE(p_no_show_charge_pence, 0) > 0
      THEN 'NO_SHOW'
    ELSE NULL
  END
$function$;

COMMENT ON FUNCTION public.trip_chargeable_terminal_outcome_kind(text, text, text, integer) IS
  '#111C unified terminal fee policy: CANCELLED_WITH_FEE is a chargeable terminal kind; wallet eligibility still requires TEN amount = capture − ACTUAL provider fee (commission 0). Mirror of terminalOutcomeKindSSOT.resolveTerminalOutcomeKind.';

REVOKE ALL ON FUNCTION public.trip_chargeable_terminal_outcome_kind(text, text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.trip_chargeable_terminal_outcome_kind(text, text, text, integer) TO service_role;

COMMIT;
