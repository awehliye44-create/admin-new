-- Driver Android ride-offer alert proof log.
--
-- The server already logs push_enqueued / push_sent / booking_received. What it
-- could not see is what the phone did with the push: whether the alert was
-- shown (and full screen), suppressed as a duplicate / finished offer, or
-- stopped. The native app reports those here; rows land in booking_delivery_log
-- next to the server phases for the same offer.
--
-- Scope: logging only. No ride_offers / trips / payment / dispatch mutation.

CREATE OR REPLACE FUNCTION public.record_offer_alert_event(
  p_offer_id uuid,
  p_phase text,
  p_detail jsonb DEFAULT '{}'::jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_driver_id uuid;
  v_trip_id uuid;
  v_phase text;
  v_detail jsonb;
  v_count integer;
BEGIN
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'unauthenticated');
  END IF;

  IF p_phase NOT IN ('push_received', 'alert_shown', 'alert_suppressed', 'alert_stopped') THEN
    RETURN jsonb_build_object('success', false, 'error', 'invalid_phase');
  END IF;
  v_phase := 'device_' || p_phase;

  SELECT id INTO v_driver_id FROM public.drivers WHERE user_id = v_uid LIMIT 1;
  IF v_driver_id IS NULL THEN
    RETURN jsonb_build_object('success', false, 'error', 'not_a_driver');
  END IF;

  SELECT trip_id INTO v_trip_id
  FROM public.ride_offers
  WHERE id = p_offer_id AND driver_id = v_driver_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'offer_not_found');
  END IF;

  -- Bound per-offer volume (duplicate pushes / reminders are legitimate but finite).
  SELECT count(*) INTO v_count
  FROM public.booking_delivery_log
  WHERE offer_id = p_offer_id
    AND driver_id = v_driver_id
    AND phase LIKE 'device\_%';
  IF v_count >= 40 THEN
    RETURN jsonb_build_object('success', false, 'error', 'rate_limited');
  END IF;

  v_detail := CASE
    WHEN jsonb_typeof(p_detail) = 'object' AND length(p_detail::text) <= 2048 THEN p_detail
    ELSE jsonb_build_object('detail_dropped', true)
  END;

  PERFORM public.record_booking_delivery(
    v_trip_id,
    v_phase,
    v_driver_id,
    p_offer_id,
    'driver_android',
    v_detail || jsonb_build_object('server_at', now())
  );

  RETURN jsonb_build_object('success', true, 'phase', v_phase);
END;
$fn$;

REVOKE ALL ON FUNCTION public.record_offer_alert_event(uuid, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_offer_alert_event(uuid, text, jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.record_offer_alert_event(uuid, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.record_offer_alert_event(uuid, text, jsonb) TO service_role;

COMMENT ON FUNCTION public.record_offer_alert_event(uuid, text, jsonb) IS
  'Driver app proof log for ride-offer alerts (device_push_received / device_alert_shown / device_alert_suppressed / device_alert_stopped). Caller must own the offer. Logging only.';
