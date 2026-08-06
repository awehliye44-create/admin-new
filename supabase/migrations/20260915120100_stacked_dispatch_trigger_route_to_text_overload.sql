-- Stacked rides matching SSOT repairs (DO NOT APPLY until reviewed).
-- Production audit findings (2026-08-06):
-- 1) tr_dispatch_trip_offers calls dispatch_trip_offers(uuid, boolean) which is
--    idle-only and never sets is_stacked.
-- 2) dispatch_trip_offers(uuid, text) stack_ok compares active_count to
--    max_stacked_rides, which rejects every busy driver when max_stacked_rides=1.
-- Correct semantics: exactly one active trip + queued_count < max_stacked_rides.

CREATE OR REPLACE FUNCTION public.tr_dispatch_trip_offers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Scan and Go retired (column dropped). Do not reference the retired flag.

  -- Corporate immediate booking: uses the same dispatcher directly.
  IF NEW.corporate_account_id IS NOT NULL
     AND COALESCE(NEW.is_scheduled, false) = false
     AND NEW.driver_id IS NULL
     AND NEW.status IN ('pending','searching') THEN
    BEGIN
      -- Route to stacked-capable overload (p_trigger_reason text), not boolean.
      PERFORM public.dispatch_trip_offers(NEW.id, 'trip_insert_corporate');
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[tr_dispatch_trip_offers] corporate dispatch failed for trip %: % (%)',
        NEW.id, SQLERRM, SQLSTATE;
    END;
    RETURN NEW;
  END IF;

  IF NEW.driver_id IS NULL
     AND COALESCE(NEW.is_scheduled, false) = false
     AND NEW.status IN ('pending','searching') THEN
    BEGIN
      PERFORM public.dispatch_trip_offers(NEW.id, 'trip_insert');
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING '[tr_dispatch_trip_offers] inline dispatch failed for trip %: % (%)',
        NEW.id, SQLERRM, SQLSTATE;
    END;
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.tr_dispatch_trip_offers() IS
  'Inline trip-insert dispatch. Must call dispatch_trip_offers(uuid, text) so stacked eligibility can run. Boolean overload is idle-only/emergency.';

-- NOTE: Full rewrite of dispatch_trip_offers(uuid, text) stack_ok block must replace:
--   active_count < COALESCE(max_stacked_rides, 1)
-- with:
--   active_count = 1
--   AND queued_count < max_stacked_rides   -- fail closed if max_stacked_rides IS NULL OR < 1
--   AND Admin allow_* lifecycle gates
-- Apply via a follow-up migration that CREATE OR REPLACE the full function body
-- from the audited production definition with those edits (body too large to
-- safely embed twice here). See STACKED_RIDES_DEPLOY_NOTES.md.
