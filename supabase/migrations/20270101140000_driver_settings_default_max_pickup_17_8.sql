-- Unify driver max pickup distance default to 17.8 miles (fleet policy).
-- Previous column default was 5.0, which excluded online drivers from ~19 km
-- pickups while peers with a raised preference still received offers
-- (see MK-261110-002 / MK0007).

ALTER TABLE public.driver_settings
  ALTER COLUMN max_pickup_distance_miles SET DEFAULT 17.8;

UPDATE public.driver_settings
SET max_pickup_distance_miles = 17.8,
    updated_at = now()
WHERE max_pickup_distance_miles IS DISTINCT FROM 17.8;
