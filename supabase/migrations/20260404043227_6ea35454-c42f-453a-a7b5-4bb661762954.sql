-- Add service_area_id to driver_wallet_ledger
ALTER TABLE public.driver_wallet_ledger
  ADD COLUMN IF NOT EXISTS service_area_id uuid REFERENCES public.service_areas(id);

-- Index for revenue queries: filter by type + date range
CREATE INDEX IF NOT EXISTS idx_dwl_type_created
  ON public.driver_wallet_ledger (type, created_at);

-- Index for service area filtering
CREATE INDEX IF NOT EXISTS idx_dwl_service_area
  ON public.driver_wallet_ledger (service_area_id)
  WHERE service_area_id IS NOT NULL;

-- Backfill service_area_id from trips for existing entries
UPDATE public.driver_wallet_ledger dwl
SET service_area_id = t.service_area_id
FROM public.trips t
WHERE dwl.related_trip_id = t.id
  AND dwl.service_area_id IS NULL
  AND t.service_area_id IS NOT NULL;