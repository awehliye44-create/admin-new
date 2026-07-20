-- Dispatch regular customer trips inline on INSERT to eliminate the 3-8s
-- wait for the periodic ride-offer sweep. scan_go and corporate paths remain
-- unchanged; failures never block the booking (sweep is still the safety net).
CREATE OR REPLACE FUNCTION public.tr_dispatch_trip_offers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Scan & Go: locked-driver direct offer
  IF COALESCE(NEW.scan_go, false) THEN
    BEGIN
      PERFORM public.dispatch_trip_offers(NEW.id, true);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[tr_dispatch_trip_offers] scan_go dispatch failed for trip %: % (%)',
        NEW.id, SQLERRM, SQLSTATE;
    END;
    RETURN NEW;
  END IF;

  -- Corporate immediate booking: uses the same dispatcher directly.
  IF NEW.corporate_account_id IS NOT NULL
     AND COALESCE(NEW.is_scheduled, false) = false
     AND NEW.driver_id IS NULL
     AND NEW.status IN ('pending','searching') THEN
    BEGIN
      PERFORM public.dispatch_trip_offers(NEW.id, true);
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[tr_dispatch_trip_offers] corporate dispatch failed for trip %: % (%)',
        NEW.id, SQLERRM, SQLSTATE;
    END;
    RETURN NEW;
  END IF;

  -- Regular customer trips (digital/paid, non-scheduled): dispatch inline
  -- so the driver receives the offer immediately instead of waiting for the
  -- 3-second sweep. Scheduled trips are intentionally skipped — they belong
  -- to schedule-dispatch (urgent-lead-time trigger).
  IF NEW.driver_id IS NULL
     AND COALESCE(NEW.is_scheduled, false) = false
     AND NEW.status IN ('pending','searching') THEN
    BEGIN
      PERFORM public.dispatch_trip_offers(NEW.id, true);
    EXCEPTION WHEN OTHERS THEN
      -- Never block the booking; the 3s sweep will retry.
      RAISE WARNING '[tr_dispatch_trip_offers] inline dispatch failed for trip %: % (%)',
        NEW.id, SQLERRM, SQLSTATE;
    END;
  END IF;

  RETURN NEW;
END;
$function$;