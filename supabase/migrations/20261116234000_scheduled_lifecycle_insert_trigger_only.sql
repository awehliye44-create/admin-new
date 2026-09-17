-- MK-260916-038: enforce_scheduled_trip_lifecycle must run BEFORE INSERT only.
-- STEP 2 UPDATE (scheduled_status=broadcasting, status=offered) must not pass
-- through this function — it always stamps unassigned rows back to scheduled.

DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT t.tgname
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE n.nspname = 'public'
      AND c.relname = 'trips'
      AND p.proname = 'enforce_scheduled_trip_lifecycle'
      AND NOT t.tgisinternal
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON public.trips', r.tgname);
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS trg_enforce_scheduled_trip_lifecycle ON public.trips;

CREATE TRIGGER trg_enforce_scheduled_trip_lifecycle
  BEFORE INSERT ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_scheduled_trip_lifecycle();

COMMENT ON TRIGGER trg_enforce_scheduled_trip_lifecycle ON public.trips IS
  'MK-260916-038: INSERT-only scheduled lifecycle. Marketplace broadcasting is owned by scheduled-dispatch STEP 2.';
