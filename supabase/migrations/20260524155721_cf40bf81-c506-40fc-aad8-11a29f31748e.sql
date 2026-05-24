-- Phase 2: drop legacy trip_offers table (replaced by ride_offers)
DROP TABLE IF EXISTS public.trip_offers CASCADE;