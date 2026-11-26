-- #118A — trips.vehicle_type text must match vehicle_type_id catalog slug.
--
-- MK-261126-016: vehicle_type_id = Pet-Friendly, but vehicle_type text stayed
-- DEFAULT 'economy' because finalize_paid_booking_session inserts only the id.
-- Dispatch gated on the id correctly; the text column misled audit/ops.
--
-- SSOT: when vehicle_type_id is set, stamp vehicle_type from vehicle_types.slug.
-- Never invent a category; never clear id. No financial mutation.
-- Does not change category gates or driver category assignments.

CREATE OR REPLACE FUNCTION public.trips_sync_vehicle_type_slug_from_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_slug text;
BEGIN
  IF NEW.vehicle_type_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.vehicle_type_id IS NOT DISTINCT FROM OLD.vehicle_type_id
     AND NEW.vehicle_type IS NOT DISTINCT FROM OLD.vehicle_type
  THEN
    RETURN NEW;
  END IF;

  SELECT vt.slug INTO v_slug
  FROM public.vehicle_types vt
  WHERE vt.id = NEW.vehicle_type_id;

  IF v_slug IS NOT NULL AND NEW.vehicle_type IS DISTINCT FROM v_slug THEN
    NEW.vehicle_type := v_slug;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_trips_sync_vehicle_type_slug_from_id ON public.trips;
CREATE TRIGGER trg_trips_sync_vehicle_type_slug_from_id
  BEFORE INSERT OR UPDATE OF vehicle_type_id, vehicle_type
  ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.trips_sync_vehicle_type_slug_from_id();

-- Heal recent mismatches (metadata only — includes terminal for audit honesty).
UPDATE public.trips t
SET vehicle_type = vt.slug,
    updated_at = now()
FROM public.vehicle_types vt
WHERE t.vehicle_type_id = vt.id
  AND t.vehicle_type IS DISTINCT FROM vt.slug
  AND t.created_at >= now() - interval '30 days';

COMMENT ON FUNCTION public.trips_sync_vehicle_type_slug_from_id() IS
  '#118A SSOT: trips.vehicle_type mirrors vehicle_types.slug for vehicle_type_id.';
