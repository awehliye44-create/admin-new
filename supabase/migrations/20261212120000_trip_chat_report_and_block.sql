-- In-trip chat safety: report a message and block the other party.
--
-- Report → one row in public.complaints (existing admin Complaints dashboard,
--          status 'new'), with a snapshot of the reported message.
-- Block  → public.customer_driver_blocks. While a block exists in either
--          direction the pair cannot exchange trip_messages and the driver is
--          never offered that passenger's trips again (same skip-one-candidate
--          pattern as the eligibility / vehicle-category checks).
--
-- Callers are resolved from auth.uid(); clients never pass their own role/id.
-- No payment, pricing, wallet or dispatch-ranking behaviour changes.

CREATE TABLE IF NOT EXISTS public.customer_driver_blocks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES public.customers(id) ON DELETE CASCADE,
  driver_id uuid NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  blocked_by text NOT NULL CHECK (blocked_by IN ('customer', 'driver')),
  trip_id uuid REFERENCES public.trips(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT customer_driver_blocks_unique UNIQUE (customer_id, driver_id, blocked_by)
);

CREATE INDEX IF NOT EXISTS customer_driver_blocks_driver_idx
  ON public.customer_driver_blocks (driver_id, customer_id);

ALTER TABLE public.customer_driver_blocks ENABLE ROW LEVEL SECURITY;

-- Each side sees only the blocks it created; never who blocked them.
DROP POLICY IF EXISTS "Customers read own blocks" ON public.customer_driver_blocks;
CREATE POLICY "Customers read own blocks" ON public.customer_driver_blocks
  FOR SELECT TO authenticated
  USING (
    blocked_by = 'customer'
    AND customer_id IN (SELECT c.id FROM public.customers c WHERE c.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Drivers read own blocks" ON public.customer_driver_blocks;
CREATE POLICY "Drivers read own blocks" ON public.customer_driver_blocks
  FOR SELECT TO authenticated
  USING (
    blocked_by = 'driver'
    AND driver_id IN (SELECT d.id FROM public.drivers d WHERE d.user_id = auth.uid())
  );

DROP POLICY IF EXISTS "Admins manage blocks" ON public.customer_driver_blocks;
CREATE POLICY "Admins manage blocks" ON public.customer_driver_blocks
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::app_role));

REVOKE ALL ON public.customer_driver_blocks FROM anon;
GRANT SELECT ON public.customer_driver_blocks TO authenticated;

CREATE OR REPLACE FUNCTION public.customer_driver_pair_blocked(
  p_customer_id uuid,
  p_driver_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT p_customer_id IS NOT NULL
    AND p_driver_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.customer_driver_blocks b
      WHERE b.customer_id = p_customer_id AND b.driver_id = p_driver_id
    );
$function$;

REVOKE ALL ON FUNCTION public.customer_driver_pair_blocked(uuid, uuid) FROM PUBLIC, anon, authenticated;

-- Resolves the caller's side of a trip from auth.uid().
CREATE OR REPLACE FUNCTION public.trip_chat_participant(p_trip_id uuid)
RETURNS TABLE (role text, customer_id uuid, driver_id uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_uid uuid := auth.uid();
  v_trip record;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'NOT_AUTHENTICATED' USING ERRCODE = 'P0001';
  END IF;

  SELECT t.passenger_id, t.driver_id INTO v_trip FROM public.trips t WHERE t.id = p_trip_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRIP_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;

  IF v_trip.passenger_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.customers c WHERE c.id = v_trip.passenger_id AND c.user_id = v_uid
  ) THEN
    RETURN QUERY SELECT 'customer'::text, v_trip.passenger_id, v_trip.driver_id;
    RETURN;
  END IF;

  IF v_trip.driver_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.drivers d WHERE d.id = v_trip.driver_id AND d.user_id = v_uid
  ) THEN
    RETURN QUERY SELECT 'driver'::text, v_trip.passenger_id, v_trip.driver_id;
    RETURN;
  END IF;

  RAISE EXCEPTION 'NOT_TRIP_PARTICIPANT' USING ERRCODE = 'P0001';
END;
$function$;

REVOKE ALL ON FUNCTION public.trip_chat_participant(uuid) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.block_trip_counterparty(p_trip_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_p record;
BEGIN
  SELECT * INTO v_p FROM public.trip_chat_participant(p_trip_id);
  IF v_p.customer_id IS NULL OR v_p.driver_id IS NULL THEN
    RAISE EXCEPTION 'TRIP_HAS_NO_COUNTERPARTY' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.customer_driver_blocks (customer_id, driver_id, blocked_by, trip_id)
  VALUES (v_p.customer_id, v_p.driver_id, v_p.role, p_trip_id)
  ON CONFLICT ON CONSTRAINT customer_driver_blocks_unique DO NOTHING;

  RETURN jsonb_build_object('blocked', true, 'blocked_by', v_p.role, 'trip_id', p_trip_id);
END;
$function$;

REVOKE ALL ON FUNCTION public.block_trip_counterparty(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.block_trip_counterparty(uuid) TO authenticated;

CREATE OR REPLACE FUNCTION public.report_trip_chat_message(
  p_trip_id uuid,
  p_message_id uuid,
  p_reason text,
  p_details text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_p record;
  v_msg record;
  v_reason text := lower(trim(COALESCE(p_reason, '')));
  v_details text := left(NULLIF(trim(COALESCE(p_details, '')), ''), 500);
  v_reporter_id uuid;
  v_reported_id uuid;
  v_customer_name text;
  v_driver_name text;
  v_driver_email text;
  v_service_area uuid;
  v_existing uuid;
  v_complaint record;
BEGIN
  IF v_reason NOT IN ('harassment', 'offensive', 'spam', 'safety', 'other') THEN
    RAISE EXCEPTION 'INVALID_REPORT_REASON' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_p FROM public.trip_chat_participant(p_trip_id);

  SELECT m.id, m.sender_type, m.message, m.created_at INTO v_msg
  FROM public.trip_messages m
  WHERE m.id = p_message_id AND m.trip_id = p_trip_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MESSAGE_NOT_FOUND' USING ERRCODE = 'P0001';
  END IF;
  -- Only the other party's messages can be reported.
  IF v_msg.sender_type IS NOT DISTINCT FROM v_p.role THEN
    RAISE EXCEPTION 'CANNOT_REPORT_OWN_MESSAGE' USING ERRCODE = 'P0001';
  END IF;

  IF v_p.role = 'customer' THEN
    v_reporter_id := v_p.customer_id;
    v_reported_id := v_p.driver_id;
  ELSE
    v_reporter_id := v_p.driver_id;
    v_reported_id := v_p.customer_id;
  END IF;

  SELECT c.id INTO v_existing
  FROM public.complaints c
  WHERE c.trip_id = p_trip_id
    AND c.reporter_id = v_reporter_id
    AND c.description LIKE '%Message ID: ' || p_message_id::text || '%'
  LIMIT 1;
  IF v_existing IS NOT NULL THEN
    SELECT id, complaint_number INTO v_complaint FROM public.complaints WHERE id = v_existing;
    RETURN jsonb_build_object(
      'reported', true, 'duplicate', true,
      'complaint_id', v_complaint.id, 'complaint_number', v_complaint.complaint_number
    );
  END IF;

  IF (
    SELECT count(*) FROM public.complaints c
    WHERE c.reporter_id = v_reporter_id
      AND c.category = 'In-trip chat'
      AND c.created_at > now() - interval '24 hours'
  ) >= 30 THEN
    RAISE EXCEPTION 'REPORT_RATE_LIMITED' USING ERRCODE = 'P0001';
  END IF;

  SELECT COALESCE(NULLIF(trim(concat_ws(' ', cu.first_name, cu.last_name)), ''), cu.customer_code, 'Passenger')
    INTO v_customer_name
  FROM public.customers cu WHERE cu.id = v_p.customer_id;
  SELECT COALESCE(NULLIF(trim(concat_ws(' ', d.first_name, d.last_name)), ''), d.driver_code, 'Driver'),
         d.service_area_id, d.email
    INTO v_driver_name, v_service_area, v_driver_email
  FROM public.drivers d WHERE d.id = v_p.driver_id;

  INSERT INTO public.complaints (
    reporter_type, reporter_id, reporter_name, reporter_email,
    reported_user_type, reported_user_id, reported_user_name,
    trip_id, category, priority, status, subject, description, service_area_id
  ) VALUES (
    CASE WHEN v_p.role = 'customer' THEN 'rider' ELSE 'driver' END,
    v_reporter_id,
    COALESCE(CASE WHEN v_p.role = 'customer' THEN v_customer_name ELSE v_driver_name END, 'Unknown'),
    CASE WHEN v_p.role = 'driver' THEN v_driver_email END,
    CASE WHEN v_p.role = 'customer' THEN 'driver' ELSE 'rider' END,
    v_reported_id,
    COALESCE(CASE WHEN v_p.role = 'customer' THEN v_driver_name ELSE v_customer_name END, 'Unknown'),
    p_trip_id,
    'In-trip chat',
    CASE WHEN v_reason = 'safety' THEN 'urgent' ELSE 'high' END,
    'new',
    'Reported chat message: ' || v_reason,
    concat_ws(E'\n',
      'Reported message: "' || left(COALESCE(v_msg.message, ''), 1000) || '"',
      'Sent at: ' || to_char(v_msg.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS') || ' UTC',
      'Message ID: ' || p_message_id::text,
      CASE WHEN v_details IS NOT NULL THEN 'Reporter note: ' || v_details END
    ),
    v_service_area
  )
  RETURNING id, complaint_number INTO v_complaint;

  RETURN jsonb_build_object(
    'reported', true, 'duplicate', false,
    'complaint_id', v_complaint.id, 'complaint_number', v_complaint.complaint_number
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.report_trip_chat_message(uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.report_trip_chat_message(uuid, uuid, text, text) TO authenticated;

-- Blocked pairs cannot exchange messages (either direction, any trip).
CREATE OR REPLACE FUNCTION public.tr_trip_messages_reject_blocked_pair()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_trip record;
BEGIN
  SELECT t.passenger_id, t.driver_id INTO v_trip FROM public.trips t WHERE t.id = NEW.trip_id;
  IF FOUND AND public.customer_driver_pair_blocked(v_trip.passenger_id, v_trip.driver_id) THEN
    RAISE EXCEPTION 'CHAT_BLOCKED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS tr_trip_messages_reject_blocked_pair ON public.trip_messages;
CREATE TRIGGER tr_trip_messages_reject_blocked_pair
  BEFORE INSERT ON public.trip_messages
  FOR EACH ROW EXECUTE FUNCTION public.tr_trip_messages_reject_blocked_pair();

-- Production definition + one added check: never offer a blocked pair.
CREATE OR REPLACE FUNCTION public.tr_block_ineligible_ride_offer()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_guard jsonb;
  v_category_reject text;
  v_passenger_id uuid;
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

  v_category_reject := public.driver_vehicle_category_reject_reason(NEW.driver_id, NEW.trip_id);
  IF v_category_reject IS NOT NULL THEN
    PERFORM public.log_driver_availability_event(
      NEW.driver_id,
      'offer_blocked_vehicle_category',
      v_category_reject,
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
    RETURN NULL;
  END IF;

  SELECT t.passenger_id INTO v_passenger_id FROM public.trips t WHERE t.id = NEW.trip_id;
  IF public.customer_driver_pair_blocked(v_passenger_id, NEW.driver_id) THEN
    PERFORM public.log_driver_availability_event(
      NEW.driver_id,
      'offer_blocked_user_block',
      'customer_driver_blocked',
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
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$function$;
