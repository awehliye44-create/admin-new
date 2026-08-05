-- PREPARED ONLY — do not apply without explicit approval.
-- Policy: Customer trip modifications apply authoritatively; Driver approval not required.
-- Driver remains notified informationally after apply (existing broadcast / push path).

CREATE OR REPLACE FUNCTION public.determine_trip_change_approval()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_delta int;
BEGIN
  v_delta := COALESCE(NEW.fare_delta_pence, 0);

  -- remove_stop never blocks on navigation impact for approval (future stop only).
  IF NEW.change_type = 'remove_stop' THEN
    NEW.navigation_impacted := false;
  END IF;

  -- Driver approval/rejection is not part of the approved workflow.
  NEW.requires_approval := false;

  IF v_delta > 0 THEN
    -- Payment gate first — never apply until payment confirmed.
    NEW.payment_status := COALESCE(NEW.payment_status, 'required');
    NEW.status := 'payment_required';
    NEW.responded_at := NULL;
    NEW.response_by := NULL;
    RETURN NEW;
  END IF;

  NEW.payment_status := COALESCE(NEW.payment_status, 'not_required');

  -- Auto-approve → apply_approved_trip_change trigger applies the trip.
  NEW.status := 'approved';
  NEW.responded_at := now();
  NEW.response_by := NEW.requester_id;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.determine_trip_change_approval() IS
  'Trip change gate: payment_required when fare increases; otherwise auto-approve. Driver approval not required.';
