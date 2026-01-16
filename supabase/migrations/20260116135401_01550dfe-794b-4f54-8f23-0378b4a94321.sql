-- Drop and recreate the view without SECURITY DEFINER
DROP VIEW IF EXISTS public.driver_wallet_balance;

-- Recreate as a regular view (SECURITY INVOKER is default)
CREATE VIEW public.driver_wallet_balance AS
SELECT 
  d.id as driver_id,
  d.first_name,
  d.last_name,
  d.email,
  COALESCE(SUM(l.amount_pence), 0)::bigint as available_pence,
  COALESCE(SUM(CASE WHEN l.amount_pence < 0 THEN l.amount_pence ELSE 0 END), 0)::bigint as total_debt_pence,
  COALESCE(SUM(CASE WHEN l.amount_pence > 0 THEN l.amount_pence ELSE 0 END), 0)::bigint as total_earnings_pence,
  COUNT(DISTINCT l.trip_id)::bigint as trip_count
FROM public.drivers d
LEFT JOIN public.driver_ledger l ON d.id = l.driver_id
GROUP BY d.id, d.first_name, d.last_name, d.email;