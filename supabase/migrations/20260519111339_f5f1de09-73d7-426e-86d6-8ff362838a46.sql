-- 1. zone_route_pricing: add airport_charge, backfill, drop old columns
ALTER TABLE public.zone_route_pricing
  ADD COLUMN IF NOT EXISTS airport_charge numeric NOT NULL DEFAULT 0;

UPDATE public.zone_route_pricing
SET airport_charge = COALESCE(
  NULLIF(airport_pickup_fee, 0),
  NULLIF(airport_dropoff_fee, 0),
  0
);

ALTER TABLE public.zone_route_pricing
  DROP COLUMN IF EXISTS pickup_fee,
  DROP COLUMN IF EXISTS dropoff_fee,
  DROP COLUMN IF EXISTS airport_pickup_fee,
  DROP COLUMN IF EXISTS airport_dropoff_fee;

-- 2. custom_zones.metadata: unify into airport_charge, strip old keys
UPDATE public.custom_zones
SET metadata = (
  (metadata - 'pickup_fee' - 'dropoff_fee' - 'airport_fee_pickup' - 'airport_fee_dropoff')
  || jsonb_build_object(
       'airport_charge',
       COALESCE(
         NULLIF((metadata->>'airport_fee_pickup')::numeric, 0),
         NULLIF((metadata->>'airport_fee_dropoff')::numeric, 0),
         0
       )
     )
)
WHERE metadata ?| array['pickup_fee','dropoff_fee','airport_fee_pickup','airport_fee_dropoff'];
