-- Follow-up hardening for the approved availability policy:
-- - admin disable is allowed during an active trip and does not clear the trip
-- - ineligible offer candidates are skipped without aborting the dispatch wave
-- - effective availability transitions are audited when intent is unchanged

BEGIN;

CREATE OR REPLACE FUNCTION public.tr_driver_status_enforce()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.driver_status IS DISTINCT FROM 'active' AND OLD.driver_status = 'active' THEN
    PERFORM public.allow_driver_availability_write();
    NEW.is_online := false;

    IF OLD.is_online IS DISTINCT FROM false THEN
      PERFORM public.log_driver_availability_event(
        NEW.id,
        'effective_offline_account',
        CASE
          WHEN NEW.driver_status = 'disabled' THEN 'admin_disabled'
          WHEN NEW.driver_status = 'deleted' THEN 'account_deleted'
          ELSE 'account_ineligible'
        END,
        OLD.driver_online_intent,
        NEW.driver_online_intent,
        OLD.is_online,
        false,
        jsonb_build_object(
          'source', 'tr_driver_status_enforce',
          'active_trip_preserved', NEW.current_trip_id IS NOT NULL
        ),
        'admin'
      );
    END IF;
  END IF;

  IF NEW.driver_status = 'deleted' AND OLD.driver_status IS DISTINCT FROM 'deleted' THEN
    -- Account deletion remains a security lifecycle action. Do not permit it to
    -- orphan an active trip; admin disable is the non-destructive control.
    IF NEW.current_trip_id IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot delete a driver with an active trip (trip_id: %)',
        NEW.current_trip_id;
    END IF;
    NEW.deleted_at := now();
  END IF;

  IF NEW.driver_status IS DISTINCT FROM 'deleted' AND OLD.driver_status = 'deleted' THEN
    NEW.deleted_at := NULL;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.tr_block_ineligible_ride_offer()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_guard jsonb;
BEGIN
  IF NEW.status IS DISTINCT FROM 'pending' OR NEW.driver_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_guard := public.accept_ride_offer_eligibility_guard(NEW.driver_id);
  IF COALESCE((v_guard ->> 'ok')::boolean, false) <> true THEN
    PERFORM public.log_driver_availability_event(
      NEW.driver_id,
      'offer_blocked_ineligible',
      COALESCE(v_guard ->> 'code', 'driver_ineligible'),
      NULL,
      NULL,
      NULL,
      NULL,
      jsonb_build_object(
        'source', 'tr_block_ineligible_ride_offer',
        'trip_id', NEW.trip_id,
        'is_stacked', COALESCE(NEW.is_stacked, false)
      ),
      'system'
    );

    -- Returning NULL from a BEFORE INSERT trigger skips only this candidate.
    -- It does not fail the whole dispatch wave or rematch an existing trip.
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.tr_audit_effective_driver_availability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_reason text;
BEGIN
  IF NEW.is_online IS NOT DISTINCT FROM OLD.is_online
     OR NEW.driver_online_intent IS DISTINCT FROM OLD.driver_online_intent
  THEN
    RETURN NEW;
  END IF;

  v_reason := CASE
    WHEN NEW.is_online = true THEN 'effective_available'
    WHEN lower(COALESCE(NEW.driver_status::text, '')) <> 'active' THEN 'account_ineligible'
    WHEN lower(COALESCE(NEW.approval_status, '')) <> 'approved' THEN 'approval_ineligible'
    WHEN COALESCE(NEW.documents_approved, false) <> true THEN 'compliance_ineligible'
    ELSE 'presence_unavailable'
  END;

  PERFORM public.log_driver_availability_event(
    NEW.id,
    'effective_availability_changed',
    v_reason,
    OLD.driver_online_intent,
    NEW.driver_online_intent,
    OLD.is_online,
    NEW.is_online,
    jsonb_build_object('source', 'drivers_after_update'),
    CASE
      WHEN auth.role() = 'service_role' THEN 'service_role'
      WHEN auth.uid() IS NULL THEN 'system'
      ELSE NULL
    END
  );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tr_audit_effective_driver_availability ON public.drivers;
CREATE TRIGGER tr_audit_effective_driver_availability
  AFTER UPDATE OF is_online
  ON public.drivers
  FOR EACH ROW
  EXECUTE FUNCTION public.tr_audit_effective_driver_availability();

REVOKE ALL ON FUNCTION public.allow_driver_availability_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.log_driver_availability_event(
  uuid, text, text, boolean, boolean, boolean, boolean, jsonb, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tr_block_ineligible_ride_offer() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.tr_audit_effective_driver_availability() FROM PUBLIC;

COMMIT;
