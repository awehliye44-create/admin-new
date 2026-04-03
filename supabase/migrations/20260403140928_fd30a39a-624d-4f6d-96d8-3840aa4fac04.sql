ALTER TABLE public.invoices
  ALTER COLUMN driver_id DROP NOT NULL;

ALTER TABLE public.lost_property_cases
  ALTER COLUMN driver_id DROP NOT NULL;

ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_driver_id_fkey,
  ADD CONSTRAINT invoices_driver_id_fkey
    FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE SET NULL;

ALTER TABLE public.lost_property_cases
  DROP CONSTRAINT IF EXISTS lost_property_cases_driver_id_fkey,
  ADD CONSTRAINT lost_property_cases_driver_id_fkey
    FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE SET NULL;

ALTER TABLE public.payments
  DROP CONSTRAINT IF EXISTS payments_driver_id_fkey,
  ADD CONSTRAINT payments_driver_id_fkey
    FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE SET NULL;

ALTER TABLE public.rider_feedback
  DROP CONSTRAINT IF EXISTS rider_feedback_driver_id_fkey,
  ADD CONSTRAINT rider_feedback_driver_id_fkey
    FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE SET NULL;

ALTER TABLE public.trips
  DROP CONSTRAINT IF EXISTS trips_driver_id_fkey,
  ADD CONSTRAINT trips_driver_id_fkey
    FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE SET NULL;

ALTER TABLE public.trips
  DROP CONSTRAINT IF EXISTS trips_confirmed_driver_id_fkey,
  ADD CONSTRAINT trips_confirmed_driver_id_fkey
    FOREIGN KEY (confirmed_driver_id) REFERENCES public.drivers(id) ON DELETE SET NULL;

ALTER TABLE public.trips
  DROP CONSTRAINT IF EXISTS trips_current_offer_driver_id_fkey,
  ADD CONSTRAINT trips_current_offer_driver_id_fkey
    FOREIGN KEY (current_offer_driver_id) REFERENCES public.drivers(id) ON DELETE SET NULL;

ALTER TABLE public.trips
  DROP CONSTRAINT IF EXISTS trips_pre_assigned_driver_id_fkey,
  ADD CONSTRAINT trips_pre_assigned_driver_id_fkey
    FOREIGN KEY (pre_assigned_driver_id) REFERENCES public.drivers(id) ON DELETE SET NULL;