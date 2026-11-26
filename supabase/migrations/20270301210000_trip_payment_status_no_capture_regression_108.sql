-- #108 — trips.payment_status must not regress after a confirmed capture.
--
-- MK-261126-005 and MK-261125-009: a delayed Revolut ORDER_AUTHORISED webhook
-- wrote payment_status=authorized after ORDER_COMPLETED had set captured.
-- payment_hold_status and capture_amount_pence stayed captured.
--
-- This trigger refuses that stale write for every writer. A row that already
-- shows a captured hold and a positive capture amount is promoted to captured
-- when a pre-capture status is written, using evidence already on the row.
-- No provider call. Does not change Stage D flags.
-- Does not update any production trip by itself; the sweep function repairs
-- rows that receive no further payment_status write.

CREATE OR REPLACE FUNCTION public.trips_refuse_regressive_payment_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  incoming text := lower(btrim(coalesce(NEW.payment_status, '')));
  prior text := lower(btrim(coalesce(OLD.payment_status, '')));
  hold text := lower(btrim(coalesce(OLD.payment_hold_status, '')));
  capture_pence integer := coalesce(OLD.capture_amount_pence, 0);
  pre_capture boolean := incoming IN (
    'authorized', 'authorised', 'pending', 'processing',
    'capture_requested', 'capture_pending',
    'preauth_authorized', 'preauth_authorised'
  );
  prior_confirmed boolean := prior IN ('captured', 'paid', 'completed');
  row_confirmed boolean := hold = 'captured' AND capture_pence > 0;
BEGIN
  IF pre_capture AND (prior_confirmed OR row_confirmed) THEN
    IF prior_confirmed THEN
      NEW.payment_status := OLD.payment_status;
    ELSE
      NEW.payment_status := 'captured';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_trips_payment_status_no_capture_regression ON public.trips;

CREATE TRIGGER trg_trips_payment_status_no_capture_regression
  BEFORE UPDATE OF payment_status ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.trips_refuse_regressive_payment_status();

REVOKE ALL ON FUNCTION public.trips_refuse_regressive_payment_status() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trips_refuse_regressive_payment_status() FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.reconcile_confirmed_capture_payment_status(
  p_limit integer DEFAULT 25,
  p_dry_run boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_ids uuid[];
  v_n integer;
  v_limit integer := LEAST(100, GREATEST(1, COALESCE(p_limit, 25)));
BEGIN
  IF COALESCE(p_dry_run, false) THEN
    SELECT coalesce(array_agg(id), '{}'::uuid[]), count(*)::int
      INTO v_ids, v_n
    FROM (
      SELECT t.id
      FROM public.trips t
      JOIN public.payment_sessions ps
        ON ps.trip_id = t.id
       AND ps.purpose = 'RIDE_BOOKING'
      WHERE lower(t.payment_status) IN (
              'authorized', 'authorised', 'pending',
              'capture_requested', 'capture_pending'
            )
        AND lower(coalesce(t.payment_hold_status, '')) = 'captured'
        AND coalesce(t.capture_amount_pence, 0) > 0
        AND ps.capture_confirmation_state = 'FULLY_CAPTURED'
        AND coalesce(ps.capture_confirmed_pence, ps.captured_amount_pence, 0) > 0
        AND upper(coalesce(ps.provider_state, '')) IN ('COMPLETED', 'CAPTURED')
        AND coalesce(ps.capture_confirmed_pence, ps.captured_amount_pence) = t.capture_amount_pence
      ORDER BY t.updated_at ASC
      LIMIT v_limit
    ) picked;
    RETURN jsonb_build_object(
      'updated', 0,
      'matched', v_n,
      'trip_ids', to_jsonb(v_ids),
      'dry_run', true
    );
  END IF;

  WITH locked AS (
    SELECT t.id
    FROM public.trips t
    JOIN public.payment_sessions ps
      ON ps.trip_id = t.id
     AND ps.purpose = 'RIDE_BOOKING'
    WHERE lower(t.payment_status) IN (
            'authorized', 'authorised', 'pending',
            'capture_requested', 'capture_pending'
          )
      AND lower(coalesce(t.payment_hold_status, '')) = 'captured'
      AND coalesce(t.capture_amount_pence, 0) > 0
      AND ps.capture_confirmation_state = 'FULLY_CAPTURED'
      AND coalesce(ps.capture_confirmed_pence, ps.captured_amount_pence, 0) > 0
      AND upper(coalesce(ps.provider_state, '')) IN ('COMPLETED', 'CAPTURED')
      AND coalesce(ps.capture_confirmed_pence, ps.captured_amount_pence) = t.capture_amount_pence
    ORDER BY t.updated_at ASC
    LIMIT v_limit
    FOR UPDATE OF t SKIP LOCKED
  ),
  upd AS (
    UPDATE public.trips t
       SET payment_status = 'captured',
           updated_at = now()
      FROM locked
     WHERE t.id = locked.id
       AND lower(t.payment_status) IN (
             'authorized', 'authorised', 'pending',
             'capture_requested', 'capture_pending'
           )
    RETURNING t.id
  )
  SELECT coalesce(array_agg(id), '{}'::uuid[]), count(*)::int
    INTO v_ids, v_n
  FROM upd;

  RETURN jsonb_build_object(
    'updated', v_n,
    'matched', v_n,
    'trip_ids', to_jsonb(v_ids),
    'dry_run', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reconcile_confirmed_capture_payment_status(integer, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_confirmed_capture_payment_status(integer, boolean) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_confirmed_capture_payment_status(integer, boolean) TO service_role;

COMMENT ON FUNCTION public.reconcile_confirmed_capture_payment_status(integer, boolean) IS
  '#108 projection repair. Sets trips.payment_status=captured only when the trip hold, capture amount, and RIDE_BOOKING session already agree the provider capture is confirmed. No provider mutation.';
