-- Customer trip rating SSOT: rider_feedback inserts require a truly completed trip.
-- Owner: public.rider_feedback (customer INSERT via current_customer_id) + this BEFORE INSERT guard.
-- Does not invent a second rating workflow.

-- Align INSERT/SELECT RLS with customers.id (not auth.uid()).
DROP POLICY IF EXISTS "Customers can create feedback" ON public.rider_feedback;
CREATE POLICY "Customers can create feedback"
ON public.rider_feedback
FOR INSERT
TO authenticated
WITH CHECK (customer_id = public.current_customer_id());

DROP POLICY IF EXISTS "Customers can read own feedback" ON public.rider_feedback;
CREATE POLICY "Customers can read own feedback"
ON public.rider_feedback
FOR SELECT
TO authenticated
USING (customer_id = public.current_customer_id());

-- One rating per customer per trip.
CREATE UNIQUE INDEX IF NOT EXISTS rider_feedback_trip_customer_uidx
  ON public.rider_feedback (trip_id, customer_id)
  WHERE trip_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.validate_rider_feedback_completion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_customer_id uuid;
  v_uid uuid := auth.uid();
BEGIN
  IF NEW.trip_id IS NULL THEN
    RAISE EXCEPTION 'RATING_REJECTED: trip_id is required';
  END IF;

  SELECT * INTO v_trip
  FROM public.trips
  WHERE id = NEW.trip_id
  FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'RATING_REJECTED: trip not found';
  END IF;

  IF lower(COALESCE(v_trip.status, '')) <> 'completed' THEN
    RAISE EXCEPTION 'RATING_REJECTED: trip status must be completed (got %)', v_trip.status;
  END IF;

  IF v_trip.completed_at IS NULL THEN
    RAISE EXCEPTION 'RATING_REJECTED: completed_at is required';
  END IF;

  -- Authenticated customer must own the trip (service_role may insert for ops tooling).
  IF COALESCE(auth.role(), '') <> 'service_role' THEN
    IF v_uid IS NULL THEN
      RAISE EXCEPTION 'RATING_REJECTED: authentication required';
    END IF;

    SELECT c.id INTO v_customer_id
    FROM public.customers c
    WHERE c.user_id = v_uid
    LIMIT 1;

    IF v_customer_id IS NULL THEN
      RAISE EXCEPTION 'RATING_REJECTED: customer profile not found';
    END IF;

    IF NEW.customer_id IS DISTINCT FROM v_customer_id THEN
      RAISE EXCEPTION 'RATING_REJECTED: customer_id does not match authenticated customer';
    END IF;

    IF v_trip.passenger_id IS DISTINCT FROM v_customer_id THEN
      RAISE EXCEPTION 'RATING_REJECTED: customer does not own this trip';
    END IF;
  END IF;

  -- Duplicate rating for same trip+customer is also blocked by unique index;
  -- fail fast with a clear code.
  IF EXISTS (
    SELECT 1
    FROM public.rider_feedback rf
    WHERE rf.trip_id = NEW.trip_id
      AND rf.customer_id = NEW.customer_id
  ) THEN
    RAISE EXCEPTION 'RATING_REJECTED: rating already submitted for this trip';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_validate_rider_feedback_completion ON public.rider_feedback;
CREATE TRIGGER trg_validate_rider_feedback_completion
BEFORE INSERT ON public.rider_feedback
FOR EACH ROW
EXECUTE FUNCTION public.validate_rider_feedback_completion();

COMMENT ON FUNCTION public.validate_rider_feedback_completion() IS
  'Rejects rider_feedback inserts unless trips.status=completed, completed_at set, customer owns trip, and no prior rating.';
