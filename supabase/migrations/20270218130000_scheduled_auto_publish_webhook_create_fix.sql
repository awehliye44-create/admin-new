-- ============================================================
-- Fix: webhook finalize_paid_booking_session created scheduled trips
-- without admin_held / publication_pending, so enforce_scheduled_trip_lifecycle
-- stamped ideal future scheduled_broadcast_at (T−urgent−response).
-- Admin showed "Requested" while drivers saw nothing until that future time.
--
-- MK-261112-006: broadcast_at=17:17 for 17:30 pickup after 17:02 Apple Pay create.
--
-- Correction:
-- 1) INSERT lifecycle: routine unassigned scheduled creates always start
--    admin_held + null broadcast_at + publication_pending (auto-publish eligible).
-- 2) Exceptional safety holds (payment/airport/manual/admin_exceptional) preserved.
-- 3) Manual/admin booking sources stay held without auto-publish eligibility.
-- 4) convert_at still stamped (T−urgent) for fallback conversion.
--
-- Auto-publish remains Edge STEP 0b / CTAP post-commit (broadcast_at := now()).
-- NOT APPLIED until explicit production approval.
-- ============================================================

CREATE OR REPLACE FUNCTION public.enforce_scheduled_trip_lifecycle()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_is_scheduled boolean;
  v_terminal boolean;
  v_broadcast timestamptz;
  v_convert timestamptz;
  v_sched text;
  v_hold text;
  v_source text;
  v_routine boolean;
BEGIN
  v_is_scheduled :=
    COALESCE(NEW.is_scheduled, false)
    OR LOWER(COALESCE(NEW.trip_type, '')) = 'scheduled'
    OR NEW.scheduled_at IS NOT NULL;

  IF NOT v_is_scheduled OR NEW.scheduled_at IS NULL THEN
    RETURN NEW;
  END IF;

  v_terminal := LOWER(COALESCE(NEW.status, '')) IN (
    'completed', 'cancelled', 'customer_cancelled', 'driver_cancelled',
    'no_show', 'expired', 'expired_no_driver'
  );

  NEW.is_scheduled := true;
  IF NEW.trip_type IS NULL OR btrim(NEW.trip_type) = '' OR LOWER(NEW.trip_type) = 'instant' THEN
    NEW.trip_type := 'scheduled';
  END IF;
  NEW.dispatch_mode := 'scheduled';

  IF NOT v_terminal THEN
    NEW.status := 'scheduled';
  END IF;

  v_sched := lower(COALESCE(NEW.scheduled_status, ''));
  v_hold := lower(btrim(COALESCE(NEW.scheduled_hold_reason, '')));
  v_source := lower(btrim(COALESCE(NEW.booking_source, '')));
  -- Routine customer/system creates (auto-publish). Manual/admin tooling stays opt-in.
  v_routine := v_source IN (
    '', 'choose_ride', 'customer_app', 'customer', 'customer_native', 'customer_web',
    'ios', 'android', 'passenger_app', 'guest', 'guest_web', 'hub', 'web',
    'corporate', 'corporate_portal', 'whatsapp', 'ctap', 'create_trip_after_payment',
    'booking_form', 'webhook'
  ) OR NEW.booking_source IS NULL;

  -- Unassigned INSERT: never stamp ideal future marketplace-open at create.
  IF TG_OP = 'INSERT'
     AND NEW.confirmed_driver_id IS NULL
     AND NEW.driver_id IS NULL
     AND NOT v_terminal
  THEN
    IF v_hold IN (
      'admin_exceptional', 'manual', 'manual_trip', 'airport_pricing',
      'payment_gate', 'publication_exhausted'
    ) THEN
      -- Genuine safety / exceptional hold — do not auto-open.
      NEW.scheduled_status := 'admin_held';
      NEW.scheduled_broadcast_at := NULL;
    ELSIF NOT v_routine THEN
      -- Manual / admin creates: held, no auto-publish eligibility.
      NEW.scheduled_status := 'admin_held';
      NEW.scheduled_broadcast_at := NULL;
      IF v_hold = '' THEN
        NEW.scheduled_hold_reason := 'manual';
      END IF;
    ELSE
      -- Routine customer/system: held + publication_pending → Edge auto-publish.
      NEW.scheduled_status := 'admin_held';
      NEW.scheduled_broadcast_at := NULL;
      IF v_hold = '' OR v_hold = 'publication_pending' OR v_hold = 'publication_retry' THEN
        NEW.scheduled_hold_reason := COALESCE(NULLIF(btrim(COALESCE(NEW.scheduled_hold_reason, '')), ''), 'publication_pending');
      END IF;
    END IF;
  ELSIF NEW.confirmed_driver_id IS NULL
     AND NEW.driver_id IS NULL
     AND NOT v_terminal
  THEN
    -- Legacy UPDATE path preserved.
    IF v_sched = 'admin_held' THEN
      NEW.scheduled_status := 'admin_held';
      NEW.scheduled_broadcast_at := NULL;
    ELSIF v_sched = '' OR v_sched IS NULL THEN
      NEW.scheduled_status := 'scheduled';
    END IF;
  END IF;

  v_sched := lower(COALESCE(NEW.scheduled_status, ''));

  IF v_sched = 'admin_held' THEN
    IF NEW.scheduled_convert_at IS NULL THEN
      SELECT a.scheduled_convert_at
        INTO v_convert
      FROM public.compute_scheduled_dispatch_anchors(NEW.scheduled_at, now()) a;
      NEW.scheduled_convert_at := v_convert;
    END IF;
    NEW.scheduled_broadcast_at := NULL;
  ELSIF NEW.scheduled_broadcast_at IS NULL OR NEW.scheduled_convert_at IS NULL THEN
    SELECT a.scheduled_broadcast_at, a.scheduled_convert_at
      INTO v_broadcast, v_convert
    FROM public.compute_scheduled_dispatch_anchors(NEW.scheduled_at, now()) a;

    IF NEW.scheduled_broadcast_at IS NULL THEN
      NEW.scheduled_broadcast_at := v_broadcast;
    END IF;
    IF NEW.scheduled_convert_at IS NULL THEN
      NEW.scheduled_convert_at := v_convert;
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.enforce_scheduled_trip_lifecycle() IS
  'Scheduled INSERT lifecycle. Routine creates → admin_held + null broadcast_at + publication_pending (auto-publish). Never stamps ideal future broadcast_at at create for customer bookings. Exceptional payment/airport/manual holds preserved.';
