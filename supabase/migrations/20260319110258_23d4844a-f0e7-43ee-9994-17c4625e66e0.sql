-- 1. Add financial status columns to trip_finance
ALTER TABLE public.trip_finance
  ADD COLUMN IF NOT EXISTS financial_status text NOT NULL DEFAULT 'recognized',
  ADD COLUMN IF NOT EXISTS revenue_type text NOT NULL DEFAULT 'completed_trip_revenue',
  ADD COLUMN IF NOT EXISTS is_financially_countable boolean NOT NULL DEFAULT true;

-- 2. Add financial_outcome column to trips for the authoritative status
ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS financial_outcome text DEFAULT NULL;

-- 3. Backfill existing completed trips
UPDATE public.trip_finance
SET financial_status = 'recognized',
    revenue_type = 'completed_trip_revenue',
    is_financially_countable = true
WHERE financial_status = 'recognized';

-- 4. Backfill trips table
UPDATE public.trips
SET financial_outcome = 'COMPLETED'
WHERE status = 'completed' AND financial_outcome IS NULL;

-- 5. Create index for financial queries
CREATE INDEX IF NOT EXISTS idx_trips_financial_outcome ON public.trips (financial_outcome) WHERE financial_outcome IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_trip_finance_revenue_type ON public.trip_finance (revenue_type);
CREATE INDEX IF NOT EXISTS idx_trip_finance_is_countable ON public.trip_finance (is_financially_countable) WHERE is_financially_countable = true;