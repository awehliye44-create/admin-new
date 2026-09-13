-- Driver Tip Thanks. Separate from passenger-tip settlement.
-- One DRIVER_TIP_CREDIT ledger row may be thanked once.
-- Does not update driver_wallet_ledger, payment sessions, invoices, or FR.

BEGIN;

CREATE TABLE IF NOT EXISTS public.driver_tip_thanks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ledger_id uuid NOT NULL UNIQUE REFERENCES public.driver_wallet_ledger (id),
  trip_id uuid NOT NULL,
  driver_id uuid NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  notification_dispatched_at timestamptz,
  customer_dismissed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS driver_tip_thanks_driver_id_idx
  ON public.driver_tip_thanks (driver_id);

CREATE INDEX IF NOT EXISTS driver_tip_thanks_trip_id_idx
  ON public.driver_tip_thanks (trip_id);

ALTER TABLE public.driver_tip_thanks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_tip_thanks FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.driver_tip_thanks FROM PUBLIC;
REVOKE ALL ON TABLE public.driver_tip_thanks FROM anon;
REVOKE ALL ON TABLE public.driver_tip_thanks FROM authenticated;

-- Shared gate. Service role / definer only. Must not be granted to clients:
-- the result includes the passenger id used to notify, never shown to the driver.
CREATE OR REPLACE FUNCTION public.driver_tip_thanks_decision(
  p_ledger_id uuid,
  p_driver_id uuid
)
RETURNS TABLE (
  ok boolean,
  code text,
  trip_id uuid,
  passenger_id uuid,
  sent_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH ledger AS (
    SELECT l.id, l.driver_id, l.type, l.amount_pence, l.related_trip_id
    FROM public.driver_wallet_ledger l
    WHERE l.id = p_ledger_id
  ),
  thanks AS (
    SELECT t.sent_at
    FROM public.driver_tip_thanks t
    WHERE t.ledger_id = p_ledger_id
  ),
  trip AS (
    SELECT
      tr.id,
      tr.passenger_id,
      tr.booking_source,
      tr.corporate_account_id
    FROM public.trips tr
    JOIN ledger l ON l.related_trip_id = tr.id
  ),
  captured AS (
    SELECT 1 AS hit
    FROM public.payment_sessions ps
    JOIN ledger l ON l.related_trip_id = ps.trip_id
    WHERE ps.status = 'captured'
      AND ps.captured_at IS NOT NULL
      AND COALESCE(ps.captured_amount_pence, 0) > 0
    LIMIT 1
  )
  SELECT
    CASE
      WHEN l.id IS NULL THEN false
      WHEN l.driver_id IS DISTINCT FROM p_driver_id THEN false
      WHEN l.type IS DISTINCT FROM 'DRIVER_TIP_CREDIT' THEN false
      WHEN COALESCE(l.amount_pence, 0) <= 0 THEN false
      WHEN NOT EXISTS (SELECT 1 FROM captured) THEN false
      WHEN NOT (
        lower(btrim(coalesce(tr.booking_source, ''))) IN ('customer', 'customer_app', 'choose_ride')
        AND NULLIF(btrim(tr.corporate_account_id::text), '') IS NULL
        AND position('whatsapp' in lower(btrim(coalesce(tr.booking_source, '')))) = 0
        AND lower(btrim(coalesce(tr.booking_source, ''))) NOT IN ('guest', 'guest_web', 'corporate')
        AND left(lower(btrim(coalesce(tr.booking_source, ''))), 10) IS DISTINCT FROM 'corporate_'
      ) THEN false
      WHEN th.sent_at IS NOT NULL THEN false
      WHEN tr.passenger_id IS NULL THEN false
      ELSE true
    END AS ok,
    CASE
      WHEN l.id IS NULL THEN 'NOT_FOUND'
      WHEN l.driver_id IS DISTINCT FROM p_driver_id THEN 'NOT_OWNER'
      WHEN l.type IS DISTINCT FROM 'DRIVER_TIP_CREDIT' THEN 'NOT_TIP_CREDIT'
      WHEN COALESCE(l.amount_pence, 0) <= 0 THEN 'TIP_NOT_POSITIVE'
      WHEN NOT EXISTS (SELECT 1 FROM captured) THEN 'CAPTURE_NOT_CONFIRMED'
      WHEN NOT (
        lower(btrim(coalesce(tr.booking_source, ''))) IN ('customer', 'customer_app', 'choose_ride')
        AND NULLIF(btrim(tr.corporate_account_id::text), '') IS NULL
        AND position('whatsapp' in lower(btrim(coalesce(tr.booking_source, '')))) = 0
        AND lower(btrim(coalesce(tr.booking_source, ''))) NOT IN ('guest', 'guest_web', 'corporate')
        AND left(lower(btrim(coalesce(tr.booking_source, ''))), 10) IS DISTINCT FROM 'corporate_'
      ) THEN 'NOT_CUSTOMER_APP'
      WHEN th.sent_at IS NOT NULL THEN 'ALREADY_SENT'
      WHEN tr.passenger_id IS NULL THEN 'NOT_CUSTOMER_APP'
      ELSE 'OK'
    END AS code,
    l.related_trip_id AS trip_id,
    tr.passenger_id,
    th.sent_at
  FROM ledger l
  LEFT JOIN thanks th ON true
  LEFT JOIN trip tr ON true;
$$;

REVOKE ALL ON FUNCTION public.driver_tip_thanks_decision(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.driver_tip_thanks_decision(uuid, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.driver_tip_thanks_decision(uuid, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.driver_tip_thanks_decision(uuid, uuid) TO service_role;

-- Driver Wallet activity. No passenger name, phone, or chat.
CREATE OR REPLACE FUNCTION public.list_driver_tip_thanks_actions(p_ledger_ids uuid[])
RETURNS TABLE (
  ledger_id uuid,
  can_send boolean,
  sent_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_driver_id uuid;
BEGIN
  SELECT d.id INTO v_driver_id
  FROM public.drivers d
  WHERE d.user_id = auth.uid()
  ORDER BY d.created_at
  LIMIT 1;

  IF v_driver_id IS NULL OR p_ledger_ids IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    l.id,
    COALESCE(dec.ok, false) AND dec.sent_at IS NULL,
    thanks.sent_at
  FROM public.driver_wallet_ledger l
  LEFT JOIN public.driver_tip_thanks thanks ON thanks.ledger_id = l.id
  LEFT JOIN LATERAL public.driver_tip_thanks_decision(l.id, v_driver_id) dec ON true
  WHERE l.id = ANY (p_ledger_ids)
    AND l.driver_id = v_driver_id
    AND l.type = 'DRIVER_TIP_CREDIT';
END;
$$;

REVOKE ALL ON FUNCTION public.list_driver_tip_thanks_actions(uuid[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_driver_tip_thanks_actions(uuid[]) FROM anon;
GRANT EXECUTE ON FUNCTION public.list_driver_tip_thanks_actions(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_driver_tip_thanks_actions(uuid[]) TO service_role;

CREATE OR REPLACE FUNCTION public.list_pending_driver_tip_thanks()
RETURNS TABLE (id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT t.id
  FROM public.driver_tip_thanks t
  JOIN public.trips tr ON tr.id = t.trip_id
  LEFT JOIN public.customers c ON c.id = tr.passenger_id
  WHERE t.customer_dismissed_at IS NULL
    AND (c.user_id = auth.uid() OR tr.passenger_id = auth.uid())
  ORDER BY t.sent_at ASC;
$$;

REVOKE ALL ON FUNCTION public.list_pending_driver_tip_thanks() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_pending_driver_tip_thanks() FROM anon;
GRANT EXECUTE ON FUNCTION public.list_pending_driver_tip_thanks() TO authenticated;
GRANT EXECUTE ON FUNCTION public.list_pending_driver_tip_thanks() TO service_role;

CREATE OR REPLACE FUNCTION public.dismiss_driver_tip_thanks(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n integer;
BEGIN
  UPDATE public.driver_tip_thanks t
  SET customer_dismissed_at = COALESCE(t.customer_dismissed_at, now())
  FROM public.trips tr
  LEFT JOIN public.customers c ON c.id = tr.passenger_id
  WHERE t.id = p_id
    AND t.trip_id = tr.id
    AND (c.user_id = auth.uid() OR tr.passenger_id = auth.uid());
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n > 0;
END;
$$;

REVOKE ALL ON FUNCTION public.dismiss_driver_tip_thanks(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.dismiss_driver_tip_thanks(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.dismiss_driver_tip_thanks(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dismiss_driver_tip_thanks(uuid) TO service_role;

COMMIT;
