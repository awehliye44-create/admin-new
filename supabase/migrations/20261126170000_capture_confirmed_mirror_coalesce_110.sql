-- #110 P4C / MK-261126-001: Stage D trip mirror must accept provider-confirmed
-- captures when capture_confirmed_pence was not yet projected but
-- captured_amount_pence + COMPLETED/CAPTURED already prove confirmation.
-- Aligns with #108 coalesce(capture_confirmed_pence, captured_amount_pence).
-- Projection repair only — no money movement.

-- Backfill missing capture_confirmed_pence from captured_amount_pence when
-- provider already terminal-completed (idempotent projection).
UPDATE public.payment_sessions ps
SET capture_confirmed_pence = ps.captured_amount_pence,
    updated_at = now()
WHERE ps.capture_confirmed_pence IS NULL
  AND COALESCE(ps.captured_amount_pence, 0) > 0
  AND upper(COALESCE(ps.provider_state, '')) IN ('COMPLETED', 'CAPTURED')
  AND lower(COALESCE(ps.status::text, '')) IN ('captured', 'completed');

CREATE OR REPLACE FUNCTION public.trips_capture_amount_confirmed_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  confirmed integer;
  strict_on boolean := false;
BEGIN
  SELECT COALESCE(c.strict_trip_capture_mirror, false)
  INTO strict_on
  FROM public.payment_ssot_cutover c
  WHERE c.id = 1;

  IF NOT COALESCE(strict_on, false) THEN
    RETURN NEW;
  END IF;

  IF NEW.capture_amount_pence IS NOT DISTINCT FROM OLD.capture_amount_pence THEN
    RETURN NEW;
  END IF;
  IF NEW.capture_amount_pence IS NULL THEN
    RETURN NEW;
  END IF;

  -- Prefer capture_confirmed_pence; fall back to captured_amount_pence when the
  -- provider state already proves capture (MK-261126-001 stamp race).
  SELECT COALESCE(ps.capture_confirmed_pence, ps.captured_amount_pence)
  INTO confirmed
  FROM public.payment_sessions ps
  WHERE ps.trip_id = NEW.id
    AND COALESCE(ps.capture_confirmed_pence, ps.captured_amount_pence, 0) > 0
    AND upper(COALESCE(ps.provider_state, '')) IN ('COMPLETED', 'CAPTURED')
  ORDER BY ps.captured_at DESC NULLS LAST, ps.updated_at DESC NULLS LAST
  LIMIT 1;

  IF confirmed IS NULL OR NEW.capture_amount_pence <> confirmed THEN
    RAISE EXCEPTION
      'trips.capture_amount_pence is legacy confirmed-only mirror; refused write % (confirmed %)',
      NEW.capture_amount_pence, confirmed
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.trips_capture_amount_confirmed_only() IS
  'Stage D: trips.capture_amount_pence may only mirror provider-confirmed session capture (coalesce confirmed/captured).';
