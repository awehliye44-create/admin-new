-- Booking dispatch wave radii: Admin → Auto-Dispatch Rules is the only source.
--
-- global_dispatch_settings.{start,expand,max}_radius_meters are ABSOLUTE
-- per-wave radii from the pickup (Wave 1 / Wave 2 / Wave 3). `valid_radii`
-- already requires 0 < W1 ≤ W2 ≤ W3 and SQL dispatch_trip_offers(uuid, text)
-- reads them that way. Edge auto-dispatch treated expand as an increment, so
-- with Admin 13 / 17 / 29 km its Wave 2 searched min(13 + 17, 29) = 29 km while
-- Admin showed 17 km (dispatch_config_snapshot radius_effective_this_round_m =
-- 29000 on every Wave 2 since at least 2026-09-26). Edge is fixed in the same
-- change; this migration documents and bounds the columns.
--
-- Towards-destination matching used the Wave 1 radius, so editing Wave 1 also
-- changed which towards-destination drivers matched. It now has its own
-- column, initialised from the Wave 1 value it shared, so behaviour is
-- unchanged until someone edits one of them.
--
-- dispatch_trip_offers(uuid) used dispatch_settings.search_radius_meters with a
-- hard-coded 5000 m fallback and dispatch_trip_offers(uuid, boolean) used the
-- start + expand increment from dispatch_settings km columns. Neither reads the
-- Admin radii. No SQL calls them (the trip-insert trigger and corporate
-- activation call the (uuid, text) overload); the Edge emergency RPC call was
-- ambiguous by argument name and could resolve to one. EXECUTE is revoked so
-- only the Admin-driven overload stays reachable.
--
-- customer_nearby_drivers_radius_meters (Customer map display) and
-- stacked_search_radius_meters are not touched.

COMMENT ON COLUMN public.global_dispatch_settings.start_radius_meters IS
  'Booking dispatch Wave 1 radius in meters from the pickup. Admin → Auto-Dispatch Rules. Absolute, not cumulative.';
COMMENT ON COLUMN public.global_dispatch_settings.expand_radius_meters IS
  'Booking dispatch Wave 2 radius in meters from the pickup. Legacy column name — an absolute radius, NOT an increment over Wave 1.';
COMMENT ON COLUMN public.global_dispatch_settings.max_radius_meters IS
  'Booking dispatch Wave 3 radius in meters from the pickup, and the cap for every wave.';

ALTER TABLE public.global_dispatch_settings
  ALTER COLUMN start_radius_meters SET DEFAULT 13000,
  ALTER COLUMN expand_radius_meters SET DEFAULT 17000,
  ALTER COLUMN max_radius_meters SET DEFAULT 29000;

-- With valid_radii (W1 ≤ W2 ≤ W3) this bounds all three waves to 500–100000 m.
ALTER TABLE public.global_dispatch_settings
  DROP CONSTRAINT IF EXISTS global_dispatch_settings_wave_radius_range;
ALTER TABLE public.global_dispatch_settings
  ADD CONSTRAINT global_dispatch_settings_wave_radius_range
  CHECK (start_radius_meters >= 500 AND max_radius_meters <= 100000);

ALTER TABLE public.global_dispatch_settings
  ADD COLUMN IF NOT EXISTS towards_destination_match_radius_meters integer;
UPDATE public.global_dispatch_settings
   SET towards_destination_match_radius_meters = start_radius_meters
 WHERE towards_destination_match_radius_meters IS NULL;
ALTER TABLE public.global_dispatch_settings
  ALTER COLUMN towards_destination_match_radius_meters SET NOT NULL;
ALTER TABLE public.global_dispatch_settings
  DROP CONSTRAINT IF EXISTS global_dispatch_settings_towards_destination_match_radius_range;
ALTER TABLE public.global_dispatch_settings
  ADD CONSTRAINT global_dispatch_settings_towards_destination_match_radius_range
  CHECK (towards_destination_match_radius_meters BETWEEN 500 AND 100000);

COMMENT ON COLUMN public.global_dispatch_settings.towards_destination_match_radius_meters IS
  'Towards-destination: max meters between a trip dropoff and the driver''s chosen destination. Independent of booking wave radii; initialised from the Wave 1 radius it previously shared.';

DO $revoke$
BEGIN
  IF to_regprocedure('public.dispatch_trip_offers(uuid)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.dispatch_trip_offers(uuid) FROM PUBLIC, anon, authenticated, service_role;
    COMMENT ON FUNCTION public.dispatch_trip_offers(uuid) IS
      'Superseded by dispatch_trip_offers(uuid, text). Ignores Admin booking radii (dispatch_settings.search_radius_meters, 5000 m fallback). EXECUTE revoked.';
  END IF;
  IF to_regprocedure('public.dispatch_trip_offers(uuid, boolean)') IS NOT NULL THEN
    REVOKE ALL ON FUNCTION public.dispatch_trip_offers(uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;
    COMMENT ON FUNCTION public.dispatch_trip_offers(uuid, boolean) IS
      'Superseded by dispatch_trip_offers(uuid, text). Ignores Admin booking radii (dispatch_effective_radius_meters start + expand increment). EXECUTE revoked.';
  END IF;
END
$revoke$;
