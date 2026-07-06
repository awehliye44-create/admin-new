ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS payment_provider text,
  ADD COLUMN IF NOT EXISTS provider_order_id text,
  ADD COLUMN IF NOT EXISTS provider_checkout_token text,
  ADD COLUMN IF NOT EXISTS provider_charge_id text;

CREATE UNIQUE INDEX IF NOT EXISTS trips_provider_order_uidx
  ON public.trips (payment_provider, provider_order_id)
  WHERE payment_provider IS NOT NULL AND provider_order_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS trips_provider_order_lookup_idx
  ON public.trips (provider_order_id)
  WHERE provider_order_id IS NOT NULL;