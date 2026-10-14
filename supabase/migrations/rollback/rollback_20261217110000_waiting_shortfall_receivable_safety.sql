-- Rollback 20261217110000_waiting_shortfall_receivable_safety
-- Restores the original release RPC (20261127150000) and drops the exception
-- RPCs and guards. The finance_shortfall_exceptions table is KEPT: its rows are
-- financial evidence. Drop it only after finance confirms every row is resolved.

BEGIN;

CREATE OR REPLACE FUNCTION public.customer_receivable_release_reservations(
  p_payment_session_id uuid,
  p_reason text DEFAULT 'session_cancelled'
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO public
AS $fn$
DECLARE
  v_alloc record;
  v_released integer := 0;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_payment_session_id IS NULL THEN
    RAISE EXCEPTION 'payment_session_id_required' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('onecab.allow_customer_receivable_write', '1', true);

  FOR v_alloc IN
    SELECT a.*
    FROM public.payment_session_receivable_allocations a
    WHERE a.payment_session_id = p_payment_session_id
      AND a.status = 'RESERVED'
    FOR UPDATE
  LOOP
    UPDATE public.payment_session_receivable_allocations
    SET
      status = 'RELEASED',
      released_at = now(),
      updated_at = now(),
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('release_reason', p_reason)
    WHERE id = v_alloc.id
      AND status = 'RESERVED';

    UPDATE public.customer_receivables
    SET
      status = 'OPEN',
      reserved_payment_session_id = NULL,
      updated_at = now()
    WHERE id = v_alloc.receivable_id
      AND status = 'RESERVED';

    INSERT INTO public.customer_receivable_events (
      receivable_id, event_type, amount_pence, payment_session_id, actor_role, note, metadata
    ) VALUES (
      v_alloc.receivable_id,
      'RELEASED',
      v_alloc.allocated_amount_pence,
      p_payment_session_id,
      'system',
      'Reservation released — receivable reopened',
      jsonb_build_object('reason', p_reason)
    );

    v_released := v_released + 1;
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'released', v_released);
END;
$fn$;

DROP FUNCTION IF EXISTS public.finance_write_off_shortfall_exception(uuid, text);
DROP FUNCTION IF EXISTS public.finance_resolve_shortfall_exception_receivable(uuid, uuid);
DROP FUNCTION IF EXISTS public.finance_record_shortfall_exception(
  text, uuid, uuid, text, uuid, text, integer, integer, integer, text, text, jsonb
);

COMMIT;
