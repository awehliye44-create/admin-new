-- Rollback 20261127140000 — restore Stage B1 RPC body; drop direct-write deny trigger.
BEGIN;

DROP TRIGGER IF EXISTS trg_deny_direct_driver_payout_pause_write ON public.drivers;
DROP FUNCTION IF EXISTS public.deny_direct_driver_payout_pause_write();

-- Restore Stage B1 definition from 20261109450000 (pre-gates).
CREATE OR REPLACE FUNCTION public.admin_set_driver_payout_operational_pause(
  p_driver_id uuid,
  p_paused boolean,
  p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_actor uuid := auth.uid();
  v_reason text := trim(coalesce(p_reason, ''));
  v_before_paused boolean;
  v_before_legacy boolean;
  v_after_legacy boolean;
  v_unchanged boolean := false;
BEGIN
  PERFORM public.assert_finance_payout_ledger_access();

  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_driver_id IS NULL THEN
    RAISE EXCEPTION 'driver_id_required' USING ERRCODE = '22023';
  END IF;

  IF p_paused IS NULL THEN
    RAISE EXCEPTION 'paused_required' USING ERRCODE = '22023';
  END IF;

  IF char_length(v_reason) < 3 OR char_length(v_reason) > 500 THEN
    RAISE EXCEPTION 'reason_required_3_to_500_chars' USING ERRCODE = '22023';
  END IF;

  SELECT
    coalesce(d.payout_operational_paused, false),
    coalesce(d.payouts_enabled, false)
  INTO v_before_paused, v_before_legacy
  FROM public.drivers d
  WHERE d.id = p_driver_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'driver_not_found' USING ERRCODE = 'P0002';
  END IF;

  v_after_legacy := NOT p_paused;

  IF v_before_paused IS NOT DISTINCT FROM p_paused
     AND v_before_legacy IS NOT DISTINCT FROM v_after_legacy THEN
    v_unchanged := true;
  ELSE
    UPDATE public.drivers d
    SET
      payout_operational_paused = p_paused,
      payouts_enabled = v_after_legacy,
      updated_at = now()
    WHERE d.id = p_driver_id;
  END IF;

  IF NOT v_unchanged THEN
    INSERT INTO public.payout_audit_log (
      driver_id,
      payout_type,
      event_type,
      metadata
    ) VALUES (
      p_driver_id,
      'operational_pause',
      CASE
        WHEN p_paused THEN 'DRIVER_PAYOUT_OPERATIONAL_PAUSE'
        ELSE 'DRIVER_PAYOUT_OPERATIONAL_RESUME'
      END,
      jsonb_build_object(
        'actor_user_id', v_actor,
        'reason', v_reason,
        'before', jsonb_build_object(
          'payout_operational_paused', v_before_paused,
          'payouts_enabled', v_before_legacy
        ),
        'after', jsonb_build_object(
          'payout_operational_paused', p_paused,
          'payouts_enabled', v_after_legacy
        ),
        'destination_mutated', false,
        'wallet_mutated', false,
        'provider_mutated', false
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'payout_operational_paused', p_paused,
    'payouts_enabled', v_after_legacy,
    'unchanged', v_unchanged
  );
END;
$function$;

ALTER FUNCTION public.admin_set_driver_payout_operational_pause(uuid, boolean, text) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.admin_set_driver_payout_operational_pause(uuid, boolean, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_set_driver_payout_operational_pause(uuid, boolean, text) FROM anon;
REVOKE ALL ON FUNCTION public.admin_set_driver_payout_operational_pause(uuid, boolean, text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_driver_payout_operational_pause(uuid, boolean, text) TO authenticated;

COMMIT;
