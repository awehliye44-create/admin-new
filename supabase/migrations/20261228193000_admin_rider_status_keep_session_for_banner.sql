-- Customer Home restriction banner needs a live JWT to hydrate rider_status.
-- Revoking auth.sessions on suspend/disable forced "Please sign in again" and
-- skipped the banner. Booking stays gated via passengerEligibility / rider_status.
-- Keep session revoke only out of this path; deleted riders stay handled elsewhere.

BEGIN;

CREATE OR REPLACE FUNCTION public.admin_set_rider_operational_status(
  p_customer_id uuid,
  p_status text,
  p_reason text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'auth'
AS $fn$
DECLARE
  v_uid uuid := auth.uid();
  v_customer public.customers%ROWTYPE;
  v_status text := lower(trim(coalesce(p_status, '')));
  v_prev text;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'admin'::public.app_role) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  IF p_customer_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'customer_id_required',
      'message', 'Customer id is required.'
    );
  END IF;

  IF v_status NOT IN ('active', 'disabled', 'suspended') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'invalid_status',
      'message', 'Status must be active, disabled, or suspended.'
    );
  END IF;

  SELECT * INTO v_customer
  FROM public.customers
  WHERE id = p_customer_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'not_found',
      'message', 'Customer not found.'
    );
  END IF;

  IF v_customer.deleted_at IS NOT NULL OR v_customer.rider_status = 'deleted' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'already_deleted',
      'message', 'Deleted customers cannot be suspended or disabled.'
    );
  END IF;

  IF v_status IN ('disabled', 'suspended')
     AND v_customer.active_trip_id IS NOT NULL
     AND v_status = 'disabled'
  THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'active_trip',
      'message', format('Cannot disable a rider with an active trip (%s).', v_customer.active_trip_id)
    );
  END IF;

  IF v_status = 'active'
     AND (v_customer.email_verified IS NOT TRUE OR v_customer.phone_verified IS NOT TRUE)
  THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'verification_required',
      'message', 'Cannot enable: email and phone must be verified.'
    );
  END IF;

  v_prev := v_customer.rider_status;

  IF v_prev IS NOT DISTINCT FROM v_status THEN
    RETURN jsonb_build_object(
      'ok', true,
      'unchanged', true,
      'rider_status', v_customer.rider_status,
      'sessions_revoked', false
    );
  END IF;

  UPDATE public.customers
  SET
    rider_status = v_status,
    updated_at = now()
  WHERE id = p_customer_id
  RETURNING * INTO v_customer;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', 'update_failed',
      'message', 'Customer status was not updated.'
    );
  END IF;

  INSERT INTO public.audit_logs (event_type, user_id, details)
  VALUES (
    CASE
      WHEN v_status = 'active' THEN 'rider_enable'
      WHEN v_status = 'disabled' THEN 'rider_disable'
      ELSE 'rider_suspend'
    END,
    v_customer.user_id,
    jsonb_build_object(
      'rider_id', v_customer.id,
      'reason', nullif(trim(coalesce(p_reason, '')), ''),
      'new_status', v_status,
      'previous_status', v_prev,
      'sessions_revoked', false,
      'source', 'admin_set_rider_operational_status'
    )
  );

  RETURN jsonb_build_object(
    'ok', true,
    'unchanged', false,
    'rider_status', v_customer.rider_status,
    'sessions_revoked', false
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error_code', SQLSTATE,
      'message', SQLERRM
    );
END;
$fn$;

COMMENT ON FUNCTION public.admin_set_rider_operational_status(uuid, text, text) IS
  'Admin-only: set rider_status active|disabled|suspended. Does not revoke Customer JWTs so the Home restriction banner can hydrate; booking stays gated by rider_status.';

REVOKE ALL ON FUNCTION public.admin_set_rider_operational_status(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.admin_set_rider_operational_status(uuid, text, text) FROM anon;
REVOKE ALL ON FUNCTION public.admin_set_rider_operational_status(uuid, text, text) FROM service_role;
GRANT EXECUTE ON FUNCTION public.admin_set_rider_operational_status(uuid, text, text) TO authenticated;

COMMIT;
