-- B1 soak follow-up: fence assert so a stale worker cannot mutate after lease
-- expiry or ownership change. Complements ownership-safe release.
-- Does NOT change TTL / rematch / waves / financial rules.

BEGIN;

CREATE OR REPLACE FUNCTION public.assert_expire_offers_lease_owner(
  p_owner_token text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_owner text;
  v_expires timestamptz;
  v_now timestamptz := now();
BEGIN
  IF current_setting('role', true) IS DISTINCT FROM 'service_role'
     AND session_user IS DISTINCT FROM 'service_role'
     AND current_user IS DISTINCT FROM 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'still_owner', false, 'error_code', 'PERMISSION_DENIED');
  END IF;

  IF p_owner_token IS NULL OR length(trim(p_owner_token)) < 8 THEN
    RETURN jsonb_build_object('ok', false, 'still_owner', false, 'error_code', 'OWNER_REQUIRED');
  END IF;

  SELECT l.owner_token, l.lease_expires_at
  INTO v_owner, v_expires
  FROM public.expire_offers_single_flight_lease l
  WHERE l.id = 1;

  IF v_owner IS NULL OR v_owner IS DISTINCT FROM trim(p_owner_token) THEN
    RETURN jsonb_build_object(
      'ok', true,
      'still_owner', false,
      'reason', 'ownership_changed'
    );
  END IF;

  IF v_expires IS NULL OR v_expires <= v_now THEN
    RETURN jsonb_build_object(
      'ok', true,
      'still_owner', false,
      'reason', 'lease_expired',
      'lease_expires_at', v_expires
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'still_owner', true,
    'owner_token', v_owner,
    'lease_expires_at', v_expires
  );
END;
$$;

REVOKE ALL ON FUNCTION public.assert_expire_offers_lease_owner(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_expire_offers_lease_owner(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assert_expire_offers_lease_owner(text) TO service_role;

COMMENT ON FUNCTION public.assert_expire_offers_lease_owner(text) IS
  'B1 fence: true only while caller still owns a non-expired expire-offers lease.';

COMMIT;
