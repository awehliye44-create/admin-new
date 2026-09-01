-- Phase 0c — model-scoped driver financial summary views (local migration; not deployed).
-- Commission Wallet ledger lives in commission_wallet_ledger — never mixed here.

BEGIN;

CREATE OR REPLACE VIEW public.platform_collected_driver_financial_summary AS
SELECT dfs.*
FROM public.driver_financial_summary dfs
WHERE EXISTS (
  SELECT 1
  FROM public.driver_wallet_ledger dwl
  JOIN public.trips t ON t.id = dwl.related_trip_id
  WHERE dwl.driver_id = dfs.driver_id
    AND t.financial_model::text = 'PLATFORM_COLLECTED'
);

COMMENT ON VIEW public.platform_collected_driver_financial_summary IS
  'Driver wallet summary scoped to PLATFORM_COLLECTED trip evidence only.';

ALTER VIEW public.platform_collected_driver_financial_summary SET (security_invoker = true);
REVOKE ALL ON public.platform_collected_driver_financial_summary FROM PUBLIC;
REVOKE ALL ON public.platform_collected_driver_financial_summary FROM anon;
REVOKE ALL ON public.platform_collected_driver_financial_summary FROM authenticated;
GRANT SELECT ON public.platform_collected_driver_financial_summary TO service_role;

CREATE OR REPLACE VIEW public.commission_wallet_driver_financial_summary AS
SELECT
  d.id AS driver_id,
  d.first_name,
  d.last_name,
  d.email,
  d.region_id,
  COALESCE(SUM(cwl.amount_pence) FILTER (
    WHERE cwl.entry_type NOT IN ('ADMIN_DEBIT', 'PAYOUT')
  ), 0)::bigint AS commission_wallet_balance_pence,
  COALESCE(SUM(cwl.amount_pence) FILTER (
    WHERE cwl.entry_type = 'ADMIN_CREDIT'
  ), 0)::bigint AS admin_credit_total_pence,
  COUNT(*) FILTER (WHERE cwl.entry_type = 'ADMIN_CREDIT') AS admin_credit_count
FROM public.drivers d
INNER JOIN public.commission_wallet_ledger cwl ON cwl.driver_id = d.id
GROUP BY d.id, d.first_name, d.last_name, d.email, d.region_id;

COMMENT ON VIEW public.commission_wallet_driver_financial_summary IS
  'Commission Wallet balances only — must not feed Payment Sessions, FR, Driver Wallet, or Payout Ledger.';

ALTER VIEW public.commission_wallet_driver_financial_summary SET (security_invoker = true);
REVOKE ALL ON public.commission_wallet_driver_financial_summary FROM PUBLIC;
REVOKE ALL ON public.commission_wallet_driver_financial_summary FROM anon;
REVOKE ALL ON public.commission_wallet_driver_financial_summary FROM authenticated;
GRANT SELECT ON public.commission_wallet_driver_financial_summary TO service_role;

COMMIT;
