-- B1: expire-offers single-flight lease (durable, Edge-safe).
-- Does NOT change offer TTL, rematch, dispatch waves, or financial paths.
-- Session advisory locks are unsafe across PostgREST pool hops; use a singleton
-- lease row with TTL so a crashed worker cannot stick beyond lease_expires_at.
--
-- NOT applied to production by this commit alone — deploy remains approval-gated.

BEGIN;

CREATE TABLE IF NOT EXISTS public.expire_offers_single_flight_lease (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  owner_token text,
  claimed_at timestamptz,
  lease_expires_at timestamptz NOT NULL DEFAULT TIMESTAMPTZ 'epoch',
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.expire_offers_single_flight_lease IS
  'B1 singleton lease for expire-offers Edge. TTL reclaim prevents stuck locks.';

INSERT INTO public.expire_offers_single_flight_lease (id, owner_token, claimed_at, lease_expires_at, updated_at)
VALUES (1, NULL, NULL, TIMESTAMPTZ 'epoch', now())
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.expire_offers_single_flight_lease ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.expire_offers_single_flight_lease FROM PUBLIC;
REVOKE ALL ON TABLE public.expire_offers_single_flight_lease FROM anon, authenticated;
GRANT SELECT, UPDATE ON TABLE public.expire_offers_single_flight_lease TO service_role;

CREATE OR REPLACE FUNCTION public.try_claim_expire_offers_lease(
  p_owner_token text,
  p_ttl_seconds integer DEFAULT 18
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_ttl integer := GREATEST(5, LEAST(COALESCE(p_ttl_seconds, 18), 60));
  v_now timestamptz := now();
  v_row public.expire_offers_single_flight_lease%ROWTYPE;
BEGIN
  IF current_setting('role', true) IS DISTINCT FROM 'service_role'
     AND session_user IS DISTINCT FROM 'service_role'
     AND current_user IS DISTINCT FROM 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'acquired', false, 'error_code', 'PERMISSION_DENIED');
  END IF;

  IF p_owner_token IS NULL OR length(trim(p_owner_token)) < 8 THEN
    RETURN jsonb_build_object('ok', false, 'acquired', false, 'error_code', 'OWNER_REQUIRED');
  END IF;

  -- Serialize claim attempts within this transaction.
  IF NOT pg_try_advisory_xact_lock(hashtext('expire_offers_single_flight_lease')) THEN
    RETURN jsonb_build_object('ok', true, 'acquired', false, 'reason', 'claim_lock_busy');
  END IF;

  UPDATE public.expire_offers_single_flight_lease AS l
  SET
    owner_token = trim(p_owner_token),
    claimed_at = v_now,
    lease_expires_at = v_now + make_interval(secs => v_ttl),
    updated_at = v_now
  WHERE l.id = 1
    AND (
      l.owner_token IS NULL
      OR l.lease_expires_at <= v_now
      OR l.owner_token = trim(p_owner_token)
    )
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', true, 'acquired', false, 'reason', 'lease_held');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'acquired', true,
    'owner_token', v_row.owner_token,
    'claimed_at', v_row.claimed_at,
    'lease_expires_at', v_row.lease_expires_at,
    'ttl_seconds', v_ttl
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.release_expire_offers_lease(
  p_owner_token text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_released boolean := false;
BEGIN
  IF current_setting('role', true) IS DISTINCT FROM 'service_role'
     AND session_user IS DISTINCT FROM 'service_role'
     AND current_user IS DISTINCT FROM 'service_role' THEN
    RETURN jsonb_build_object('ok', false, 'released', false, 'error_code', 'PERMISSION_DENIED');
  END IF;

  IF p_owner_token IS NULL OR length(trim(p_owner_token)) < 8 THEN
    RETURN jsonb_build_object('ok', false, 'released', false, 'error_code', 'OWNER_REQUIRED');
  END IF;

  UPDATE public.expire_offers_single_flight_lease AS l
  SET
    owner_token = NULL,
    claimed_at = NULL,
    lease_expires_at = TIMESTAMPTZ 'epoch',
    updated_at = now()
  WHERE l.id = 1
    AND l.owner_token = trim(p_owner_token);

  v_released := FOUND;

  -- Ownership-safe: if another worker reclaimed after TTL, this is a no-op success.
  RETURN jsonb_build_object(
    'ok', true,
    'released', v_released,
    'reason', CASE WHEN v_released THEN 'released' ELSE 'not_owner_or_already_free' END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.try_claim_expire_offers_lease(text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.try_claim_expire_offers_lease(text, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.try_claim_expire_offers_lease(text, integer) TO service_role;

REVOKE ALL ON FUNCTION public.release_expire_offers_lease(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.release_expire_offers_lease(text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_expire_offers_lease(text) TO service_role;

COMMENT ON FUNCTION public.try_claim_expire_offers_lease(text, integer) IS
  'B1: try claim expire-offers singleton lease. Expired/free leases reclaimable; service_role only.';
COMMENT ON FUNCTION public.release_expire_offers_lease(text) IS
  'B1: release expire-offers lease only if caller still owns it (stale-worker safe).';

COMMIT;
