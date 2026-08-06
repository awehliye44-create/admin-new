-- Prevent duplicate driver earnings invoices for the same period.
-- report_type is represented by invoices.statement_run_id / period bounds on invoices.

CREATE UNIQUE INDEX IF NOT EXISTS invoices_driver_period_unique
  ON public.invoices (driver_id, period_start, period_end)
  WHERE driver_id IS NOT NULL
    AND period_start IS NOT NULL
    AND period_end IS NOT NULL
    AND COALESCE(status, '') <> 'cancelled';

COMMENT ON INDEX public.invoices_driver_period_unique IS
  'One active driver earnings invoice per driver_id + period_start + period_end';
