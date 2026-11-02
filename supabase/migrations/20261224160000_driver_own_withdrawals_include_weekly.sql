-- Driver Portal / Driver App payout history: include weekly scheduled payouts.
-- get_driver_own_withdrawals previously returned EARLY_CASHOUT only, so weekly
-- completed payouts were invisible even though they belong to the same driver.
-- Still SECURITY DEFINER + auth.uid() ownership; no direct table RLS restored.

CREATE OR REPLACE FUNCTION public.get_driver_own_withdrawals(
  p_filter text DEFAULT NULL
)
RETURNS TABLE (
  id                      uuid,
  status                  text,
  amount_pence            integer,
  net_driver_payout_pence bigint,
  onecab_fee_pence        bigint,
  created_at              timestamptz,
  completed_at            timestamptz,
  failed_at               timestamptz,
  failure_reason          text,
  failure_code            text,
  error_message           text,
  batch_kind              text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_driver_id uuid;
BEGIN
  IF p_filter IS NOT NULL AND p_filter NOT IN ('pending', 'completed', 'failed') THEN
    RAISE EXCEPTION 'get_driver_own_withdrawals: invalid filter value %', p_filter
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT d.id INTO v_driver_id
  FROM public.drivers d
  WHERE d.user_id = auth.uid()
  LIMIT 1;

  IF v_driver_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    pi.id,
    pi.status::text,
    pi.amount_pence,
    pi.net_driver_payout_pence,
    pi.onecab_fee_pence,
    pi.created_at,
    pi.completed_at,
    pi.failed_at,
    pi.failure_reason::text,
    pi.failure_code::text,
    pi.error_message::text,
    pb.kind::text AS batch_kind
  FROM public.payout_items  pi
  JOIN public.payout_batches pb ON pb.id = pi.batch_id
  WHERE pi.driver_id = v_driver_id
    AND pb.kind IN ('EARLY_CASHOUT', 'WEEKLY_SCHEDULED', 'WEEKLY_MONDAY')
    AND (
      p_filter IS NULL
      OR (p_filter = 'pending'
          AND pi.status IN ('VALIDATED','RESERVING','RESERVED',
                            'SUBMITTING','SUBMITTED','UNKNOWN'))
      OR (p_filter = 'completed'
          AND pi.status IN ('COMPLETED','PAID'))
      OR (p_filter = 'failed'
          AND pi.status IN ('FAILED','DECLINED','RELEASED','CANCELLED'))
    )
  ORDER BY pi.created_at DESC
  LIMIT 50;
END;
$$;

COMMENT ON FUNCTION public.get_driver_own_withdrawals(text) IS
  'Driver-owned payout history (early cashout + weekly). Identity from auth.uid(); filter pending|completed|failed|NULL.';

CREATE OR REPLACE FUNCTION public.get_driver_own_withdrawal(
  p_withdrawal_id uuid
)
RETURNS TABLE (
  id                      uuid,
  status                  text,
  amount_pence            integer,
  net_driver_payout_pence bigint,
  onecab_fee_pence        bigint,
  created_at              timestamptz,
  completed_at            timestamptz,
  failed_at               timestamptz,
  failure_reason          text,
  failure_code            text,
  error_message           text,
  batch_kind              text,
  financially_applied_at  timestamptz,
  provider_state          text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_driver_id uuid;
BEGIN
  SELECT d.id INTO v_driver_id
  FROM public.drivers d
  WHERE d.user_id = auth.uid()
  LIMIT 1;

  IF v_driver_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    pi.id,
    pi.status::text,
    pi.amount_pence,
    pi.net_driver_payout_pence,
    pi.onecab_fee_pence,
    pi.created_at,
    pi.completed_at,
    pi.failed_at,
    pi.failure_reason::text,
    pi.failure_code::text,
    pi.error_message::text,
    pb.kind::text                   AS batch_kind,
    dppi.financially_applied_at,
    dppi.provider_state::text
  FROM public.payout_items           pi
  JOIN public.payout_batches         pb   ON pb.id   = pi.batch_id
  LEFT JOIN public.driver_payout_payment_intents dppi
                                          ON dppi.payout_item_id = pi.id
  WHERE pi.id        = p_withdrawal_id
    AND pi.driver_id = v_driver_id
    AND pb.kind IN ('EARLY_CASHOUT', 'WEEKLY_SCHEDULED', 'WEEKLY_MONDAY')
  LIMIT 1;
END;
$$;

COMMENT ON FUNCTION public.get_driver_own_withdrawal(uuid) IS
  'Single driver-owned payout detail (early cashout + weekly). Identity from auth.uid().';

REVOKE ALL ON FUNCTION public.get_driver_own_withdrawals(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_driver_own_withdrawals(text) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_driver_own_withdrawals(text) TO authenticated;

REVOKE ALL ON FUNCTION public.get_driver_own_withdrawal(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_driver_own_withdrawal(uuid) FROM anon;
GRANT  EXECUTE ON FUNCTION public.get_driver_own_withdrawal(uuid) TO authenticated;
