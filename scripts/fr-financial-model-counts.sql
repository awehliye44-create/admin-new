-- Read-only production financial_model distribution report (do not mutate).
-- Run manually against linked prod when authorised.

SELECT
  COALESCE(financial_model::text, 'NULL') AS financial_model,
  COUNT(*) AS trip_count
FROM public.trips
GROUP BY 1
ORDER BY trip_count DESC;

SELECT
  COUNT(*) FILTER (WHERE financial_model::text = 'PLATFORM_COLLECTED') AS platform_collected,
  COUNT(*) FILTER (WHERE financial_model::text = 'DRIVER_COLLECTED_COMMISSION_WALLET') AS driver_collected_commission_wallet,
  COUNT(*) FILTER (WHERE financial_model IS NULL) AS null_financial_model,
  COUNT(*) FILTER (
    WHERE financial_model IS NOT NULL
      AND financial_model::text NOT IN ('PLATFORM_COLLECTED', 'DRIVER_COLLECTED_COMMISSION_WALLET')
  ) AS unknown_values
FROM public.trips;
