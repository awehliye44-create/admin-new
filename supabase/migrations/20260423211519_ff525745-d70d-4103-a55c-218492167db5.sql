-- Allow service areas to be deleted while preserving historical/audit references.
-- Convert all NO ACTION foreign keys on service_areas(id) to ON DELETE SET NULL.

ALTER TABLE public.trips
  DROP CONSTRAINT IF EXISTS trips_service_area_id_fkey,
  ADD CONSTRAINT trips_service_area_id_fkey
    FOREIGN KEY (service_area_id) REFERENCES public.service_areas(id) ON DELETE SET NULL;

ALTER TABLE public.trip_finance
  DROP CONSTRAINT IF EXISTS trip_finance_service_area_id_fkey,
  ADD CONSTRAINT trip_finance_service_area_id_fkey
    FOREIGN KEY (service_area_id) REFERENCES public.service_areas(id) ON DELETE SET NULL;

ALTER TABLE public.complaints
  DROP CONSTRAINT IF EXISTS complaints_service_area_id_fkey,
  ADD CONSTRAINT complaints_service_area_id_fkey
    FOREIGN KEY (service_area_id) REFERENCES public.service_areas(id) ON DELETE SET NULL;

ALTER TABLE public.corporate_account_requests
  DROP CONSTRAINT IF EXISTS corporate_account_requests_service_area_id_fkey,
  ADD CONSTRAINT corporate_account_requests_service_area_id_fkey
    FOREIGN KEY (service_area_id) REFERENCES public.service_areas(id) ON DELETE SET NULL;

ALTER TABLE public.corporate_accounts
  DROP CONSTRAINT IF EXISTS corporate_accounts_service_area_id_fkey,
  ADD CONSTRAINT corporate_accounts_service_area_id_fkey
    FOREIGN KEY (service_area_id) REFERENCES public.service_areas(id) ON DELETE SET NULL;

ALTER TABLE public.corporate_invoices
  DROP CONSTRAINT IF EXISTS corporate_invoices_service_area_id_fkey,
  ADD CONSTRAINT corporate_invoices_service_area_id_fkey
    FOREIGN KEY (service_area_id) REFERENCES public.service_areas(id) ON DELETE SET NULL;

ALTER TABLE public.driver_statements
  DROP CONSTRAINT IF EXISTS driver_statements_service_area_id_fkey,
  ADD CONSTRAINT driver_statements_service_area_id_fkey
    FOREIGN KEY (service_area_id) REFERENCES public.service_areas(id) ON DELETE SET NULL;

ALTER TABLE public.driver_wallet_ledger
  DROP CONSTRAINT IF EXISTS driver_wallet_ledger_service_area_id_fkey,
  ADD CONSTRAINT driver_wallet_ledger_service_area_id_fkey
    FOREIGN KEY (service_area_id) REFERENCES public.service_areas(id) ON DELETE SET NULL;

ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_service_area_id_fkey,
  ADD CONSTRAINT invoices_service_area_id_fkey
    FOREIGN KEY (service_area_id) REFERENCES public.service_areas(id) ON DELETE SET NULL;

ALTER TABLE public.lost_property_cases
  DROP CONSTRAINT IF EXISTS lost_property_cases_service_area_id_fkey,
  ADD CONSTRAINT lost_property_cases_service_area_id_fkey
    FOREIGN KEY (service_area_id) REFERENCES public.service_areas(id) ON DELETE SET NULL;

ALTER TABLE public.statement_runs
  DROP CONSTRAINT IF EXISTS statement_runs_service_area_id_fkey,
  ADD CONSTRAINT statement_runs_service_area_id_fkey
    FOREIGN KEY (service_area_id) REFERENCES public.service_areas(id) ON DELETE SET NULL;