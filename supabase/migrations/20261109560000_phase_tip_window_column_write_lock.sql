-- Tip amount and tip-window stamps are service-role only.
-- Driver RLS allows UPDATE on assigned trips (any column). Without this guard a
-- driver JWT can raise tip_amount_pence (expiry then captures it) or push
-- tip_window_expires_at out so fare capture never runs.
-- auth.uid() IS NULL covers edge service_role and cron (no user JWT).

CREATE OR REPLACE FUNCTION public.guard_trip_tip_window_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $fn$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF coalesce(NEW.tip_amount_pence, 0) <> 0
       OR coalesce(NEW.tip_pence, 0) <> 0
       OR NEW.tip_window_expires_at IS NOT NULL
       OR NEW.tip_window_closed_at IS NOT NULL
       OR NEW.tip_window_opened_at IS NOT NULL
       OR NEW.tip_window_status IS NOT NULL
    THEN
      RAISE EXCEPTION 'TIP_WINDOW_COLUMNS_LOCKED'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.tip_amount_pence IS DISTINCT FROM OLD.tip_amount_pence
     OR NEW.tip_pence IS DISTINCT FROM OLD.tip_pence
     OR NEW.tip_window_expires_at IS DISTINCT FROM OLD.tip_window_expires_at
     OR NEW.tip_window_closed_at IS DISTINCT FROM OLD.tip_window_closed_at
     OR NEW.tip_window_opened_at IS DISTINCT FROM OLD.tip_window_opened_at
     OR NEW.tip_window_status IS DISTINCT FROM OLD.tip_window_status
  THEN
    RAISE EXCEPTION 'TIP_WINDOW_COLUMNS_LOCKED'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.guard_trip_tip_window_columns() IS
  'Rejects authenticated writes to tip amount and tip-window stamps. Service role (auth.uid() null) retains ownership.';

REVOKE ALL ON FUNCTION public.guard_trip_tip_window_columns() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_trip_tip_window_columns() FROM anon;
REVOKE ALL ON FUNCTION public.guard_trip_tip_window_columns() FROM authenticated;
REVOKE ALL ON FUNCTION public.guard_trip_tip_window_columns() FROM service_role;

DROP TRIGGER IF EXISTS trg_guard_trip_tip_window_columns ON public.trips;
CREATE TRIGGER trg_guard_trip_tip_window_columns
  BEFORE INSERT OR UPDATE ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.guard_trip_tip_window_columns();
