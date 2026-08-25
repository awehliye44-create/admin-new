-- ============================================================
-- 20261022120000_revolut_business_oauth_refresh_ownership.sql
--
-- Step 9.4D1 — Durable on-demand Revolut Business OAuth refresh ownership
-- (Model B: ON_DEMAND_CANONICAL_REFRESH_WITH_DURABLE_DB_CLAIM).
--
-- DO NOT apply to production in this step — local / throwaway only until
-- an explicit later deploy step.
--
-- Exactly one claimant may refresh+persist for a given credential_generation.
-- RPCs never return access token, refresh token, or private key material.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.revolut_business_oauth_refresh_coord (
  provider text NOT NULL,
  environment text NOT NULL,
  refresh_claim_token uuid NULL,
  refresh_claimed_at timestamptz NULL,
  refresh_claim_expires_at timestamptz NULL,
  credential_generation bigint NOT NULL DEFAULT 0,
  last_refresh_attempt_at timestamptz NULL,
  last_refresh_success_at timestamptz NULL,
  last_refresh_error_code text NULL,
  access_token_expires_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT revolut_business_oauth_refresh_coord_pkey PRIMARY KEY (provider, environment),
  CONSTRAINT revolut_business_oauth_refresh_coord_provider_chk
    CHECK (provider = 'revolut'),
  CONSTRAINT revolut_business_oauth_refresh_coord_env_chk
    CHECK (environment IN ('live', 'test'))
);

COMMENT ON TABLE public.revolut_business_oauth_refresh_coord IS
  'Coordination row for Revolut Business OAuth refresh claims (Model B). '
  'Secrets remain in payment_provider_vault; this table holds claim/CAS only.';

-- Seed live row from vault expiry when present (idempotent).
INSERT INTO public.revolut_business_oauth_refresh_coord (
  provider, environment, access_token_expires_at, credential_generation
)
SELECT
  'revolut',
  'live',
  CASE
    WHEN v.secret_value ~ '^[0-9]{4}-'
      THEN v.secret_value::timestamptz
    ELSE NULL
  END,
  0
FROM public.payment_provider_vault v
WHERE v.provider = 'revolut'
  AND v.environment = 'live'
  AND v.secret_name = 'business_token_expires_at'
ON CONFLICT (provider, environment) DO NOTHING;

INSERT INTO public.revolut_business_oauth_refresh_coord (provider, environment)
VALUES ('revolut', 'live')
ON CONFLICT (provider, environment) DO NOTHING;

ALTER TABLE public.revolut_business_oauth_refresh_coord ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS revolut_business_oauth_refresh_coord_deny_all
  ON public.revolut_business_oauth_refresh_coord;
CREATE POLICY revolut_business_oauth_refresh_coord_deny_all
  ON public.revolut_business_oauth_refresh_coord
  FOR ALL
  TO anon, authenticated
  USING (false)
  WITH CHECK (false);

REVOKE ALL ON TABLE public.revolut_business_oauth_refresh_coord FROM PUBLIC;
REVOKE ALL ON TABLE public.revolut_business_oauth_refresh_coord FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.revolut_business_oauth_refresh_coord TO service_role;

-- ── claim ───────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.claim_revolut_business_oauth_refresh(
  p_provider text DEFAULT 'revolut',
  p_environment text DEFAULT 'live',
  p_skew_seconds integer DEFAULT 60,
  p_claim_ttl_seconds integer DEFAULT 45
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_now timestamptz := now();
  v_row public.revolut_business_oauth_refresh_coord%ROWTYPE;
  v_claim uuid;
  v_skew interval;
  v_ttl interval;
  v_vault_expires timestamptz;
BEGIN
  IF p_provider IS DISTINCT FROM 'revolut' THEN
    RAISE EXCEPTION 'provider_must_be_revolut' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_environment IS NULL OR btrim(p_environment) = '' THEN
    RAISE EXCEPTION 'environment_required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_skew_seconds IS NULL OR p_skew_seconds < 0 OR p_skew_seconds > 3600 THEN
    RAISE EXCEPTION 'skew_out_of_bounds' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_claim_ttl_seconds IS NULL OR p_claim_ttl_seconds < 5 OR p_claim_ttl_seconds > 300 THEN
    RAISE EXCEPTION 'claim_ttl_out_of_bounds' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_skew := make_interval(secs => p_skew_seconds);
  v_ttl := make_interval(secs => p_claim_ttl_seconds);

  INSERT INTO public.revolut_business_oauth_refresh_coord (provider, environment)
  VALUES (p_provider, p_environment)
  ON CONFLICT (provider, environment) DO NOTHING;

  SELECT * INTO v_row
  FROM public.revolut_business_oauth_refresh_coord c
  WHERE c.provider = p_provider
    AND c.environment = p_environment
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'coord_row_missing' USING ERRCODE = 'no_data_found';
  END IF;

  -- Authoritative expiry: prefer coord; fall back to vault once under lock.
  IF v_row.access_token_expires_at IS NULL THEN
    SELECT
      CASE
        WHEN vv.secret_value ~ '^[0-9]{4}-' THEN vv.secret_value::timestamptz
        ELSE NULL
      END
    INTO v_vault_expires
    FROM public.payment_provider_vault vv
    WHERE vv.provider = p_provider
      AND vv.environment = p_environment
      AND vv.secret_name = 'business_token_expires_at'
    LIMIT 1;

    IF v_vault_expires IS NOT NULL THEN
      UPDATE public.revolut_business_oauth_refresh_coord c
      SET access_token_expires_at = v_vault_expires,
          updated_at = v_now
      WHERE c.provider = p_provider
        AND c.environment = p_environment;
      v_row.access_token_expires_at := v_vault_expires;
    END IF;
  END IF;

  -- Fresh outside skew → read-only.
  IF v_row.access_token_expires_at IS NOT NULL
     AND v_row.access_token_expires_at > v_now + v_skew
  THEN
    RETURN jsonb_build_object(
      'status', 'TOKEN_ALREADY_FRESH',
      'provider', p_provider,
      'environment', p_environment,
      'credential_generation', v_row.credential_generation,
      'access_token_expires_at', v_row.access_token_expires_at,
      'refresh_claim_expires_at', NULL,
      'claim_token', NULL
    );
  END IF;

  -- Active claim held by another worker.
  IF v_row.refresh_claim_token IS NOT NULL
     AND v_row.refresh_claim_expires_at IS NOT NULL
     AND v_row.refresh_claim_expires_at > v_now
  THEN
    RETURN jsonb_build_object(
      'status', 'REFRESH_IN_PROGRESS',
      'provider', p_provider,
      'environment', p_environment,
      'credential_generation', v_row.credential_generation,
      'access_token_expires_at', v_row.access_token_expires_at,
      'refresh_claim_expires_at', v_row.refresh_claim_expires_at,
      'claim_token', NULL
    );
  END IF;

  -- Claim (including reclaim after TTL expiry).
  v_claim := gen_random_uuid();
  UPDATE public.revolut_business_oauth_refresh_coord c
  SET
    refresh_claim_token = v_claim,
    refresh_claimed_at = v_now,
    refresh_claim_expires_at = v_now + v_ttl,
    last_refresh_attempt_at = v_now,
    last_refresh_error_code = NULL,
    updated_at = v_now
  WHERE c.provider = p_provider
    AND c.environment = p_environment
    AND (
      c.refresh_claim_token IS NULL
      OR c.refresh_claim_expires_at IS NULL
      OR c.refresh_claim_expires_at <= v_now
    )
  RETURNING * INTO v_row;

  IF NOT FOUND THEN
    -- Lost race after lock release edge — treat as in progress.
    SELECT * INTO v_row
    FROM public.revolut_business_oauth_refresh_coord c
    WHERE c.provider = p_provider AND c.environment = p_environment;
    RETURN jsonb_build_object(
      'status', 'REFRESH_IN_PROGRESS',
      'provider', p_provider,
      'environment', p_environment,
      'credential_generation', v_row.credential_generation,
      'access_token_expires_at', v_row.access_token_expires_at,
      'refresh_claim_expires_at', v_row.refresh_claim_expires_at,
      'claim_token', NULL
    );
  END IF;

  RETURN jsonb_build_object(
    'status', 'CLAIMED',
    'provider', p_provider,
    'environment', p_environment,
    'credential_generation', v_row.credential_generation,
    'access_token_expires_at', v_row.access_token_expires_at,
    'refresh_claim_expires_at', v_row.refresh_claim_expires_at,
    'claim_token', v_claim
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_revolut_business_oauth_refresh(text, text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_revolut_business_oauth_refresh(text, text, integer, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_revolut_business_oauth_refresh(text, text, integer, integer) TO service_role;

-- ── complete ────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.complete_revolut_business_oauth_refresh(
  p_claim_token uuid,
  p_expected_generation bigint,
  p_access_token text,
  p_expires_at timestamptz,
  p_refresh_token text DEFAULT NULL,
  p_scopes_granted text DEFAULT NULL,
  p_provider text DEFAULT 'revolut',
  p_environment text DEFAULT 'live'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_now timestamptz := now();
  v_row public.revolut_business_oauth_refresh_coord%ROWTYPE;
  v_new_gen bigint;
BEGIN
  IF p_claim_token IS NULL THEN
    RAISE EXCEPTION 'claim_token_required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_expected_generation IS NULL OR p_expected_generation < 0 THEN
    RAISE EXCEPTION 'expected_generation_invalid' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_access_token IS NULL OR btrim(p_access_token) = '' THEN
    RAISE EXCEPTION 'access_token_required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_expires_at IS NULL OR p_expires_at <= v_now THEN
    RAISE EXCEPTION 'expires_at_invalid' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_provider IS DISTINCT FROM 'revolut' THEN
    RAISE EXCEPTION 'provider_must_be_revolut' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT * INTO v_row
  FROM public.revolut_business_oauth_refresh_coord c
  WHERE c.provider = p_provider
    AND c.environment = p_environment
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'COORD_MISSING', 'persisted', false);
  END IF;

  IF v_row.refresh_claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN jsonb_build_object(
      'status', 'CLAIM_MISMATCH',
      'persisted', false,
      'credential_generation', v_row.credential_generation
    );
  END IF;

  IF v_row.credential_generation IS DISTINCT FROM p_expected_generation THEN
    RETURN jsonb_build_object(
      'status', 'STALE_GENERATION',
      'persisted', false,
      'credential_generation', v_row.credential_generation
    );
  END IF;

  -- Persist secrets (mirrors both naming conventions used by Edge).
  INSERT INTO public.payment_provider_vault AS v
    (provider, environment, secret_name, secret_value, updated_at)
  VALUES
    (p_provider, p_environment, 'business_access_token', btrim(p_access_token), v_now)
  ON CONFLICT (provider, environment, secret_name) DO UPDATE
  SET secret_value = EXCLUDED.secret_value, updated_at = EXCLUDED.updated_at;

  INSERT INTO public.payment_provider_vault AS v
    (provider, environment, secret_name, secret_value, updated_at)
  VALUES
    (p_provider, p_environment, 'REVOLUT_BUSINESS_ACCESS_TOKEN', btrim(p_access_token), v_now)
  ON CONFLICT (provider, environment, secret_name) DO UPDATE
  SET secret_value = EXCLUDED.secret_value, updated_at = EXCLUDED.updated_at;

  IF p_refresh_token IS NOT NULL AND btrim(p_refresh_token) <> '' THEN
    INSERT INTO public.payment_provider_vault AS v
      (provider, environment, secret_name, secret_value, updated_at)
    VALUES
      (p_provider, p_environment, 'business_refresh_token', btrim(p_refresh_token), v_now)
    ON CONFLICT (provider, environment, secret_name) DO UPDATE
    SET secret_value = EXCLUDED.secret_value, updated_at = EXCLUDED.updated_at;

    INSERT INTO public.payment_provider_vault AS v
      (provider, environment, secret_name, secret_value, updated_at)
    VALUES
      (p_provider, p_environment, 'REVOLUT_BUSINESS_REFRESH_TOKEN', btrim(p_refresh_token), v_now)
    ON CONFLICT (provider, environment, secret_name) DO UPDATE
    SET secret_value = EXCLUDED.secret_value, updated_at = EXCLUDED.updated_at;
  END IF;

  INSERT INTO public.payment_provider_vault AS v
    (provider, environment, secret_name, secret_value, updated_at)
  VALUES
    (p_provider, p_environment, 'business_token_expires_at', p_expires_at::text, v_now)
  ON CONFLICT (provider, environment, secret_name) DO UPDATE
  SET secret_value = EXCLUDED.secret_value, updated_at = EXCLUDED.updated_at;

  INSERT INTO public.payment_provider_vault AS v
    (provider, environment, secret_name, secret_value, updated_at)
  VALUES
    (p_provider, p_environment, 'REVOLUT_BUSINESS_TOKEN_EXPIRES_AT', p_expires_at::text, v_now)
  ON CONFLICT (provider, environment, secret_name) DO UPDATE
  SET secret_value = EXCLUDED.secret_value, updated_at = EXCLUDED.updated_at;

  IF p_scopes_granted IS NOT NULL AND btrim(p_scopes_granted) <> '' THEN
    INSERT INTO public.payment_provider_vault AS v
      (provider, environment, secret_name, secret_value, updated_at)
    VALUES
      (p_provider, p_environment, 'business_oauth_scopes_granted', btrim(p_scopes_granted), v_now)
    ON CONFLICT (provider, environment, secret_name) DO UPDATE
    SET secret_value = EXCLUDED.secret_value, updated_at = EXCLUDED.updated_at;

    INSERT INTO public.payment_provider_vault AS v
      (provider, environment, secret_name, secret_value, updated_at)
    VALUES
      (p_provider, p_environment, 'REVOLUT_BUSINESS_OAUTH_SCOPES_GRANTED', btrim(p_scopes_granted), v_now)
    ON CONFLICT (provider, environment, secret_name) DO UPDATE
    SET secret_value = EXCLUDED.secret_value, updated_at = EXCLUDED.updated_at;
  END IF;

  v_new_gen := v_row.credential_generation + 1;

  UPDATE public.revolut_business_oauth_refresh_coord c
  SET
    refresh_claim_token = NULL,
    refresh_claimed_at = NULL,
    refresh_claim_expires_at = NULL,
    credential_generation = v_new_gen,
    access_token_expires_at = p_expires_at,
    last_refresh_success_at = v_now,
    last_refresh_error_code = NULL,
    updated_at = v_now
  WHERE c.provider = p_provider
    AND c.environment = p_environment
    AND c.refresh_claim_token = p_claim_token
    AND c.credential_generation = p_expected_generation;

  IF NOT FOUND THEN
    -- Should not happen after FOR UPDATE + checks; fail closed without lying.
    RETURN jsonb_build_object(
      'status', 'COMPLETE_RACE',
      'persisted', false,
      'credential_generation', v_row.credential_generation
    );
  END IF;

  RETURN jsonb_build_object(
    'status', 'COMPLETED',
    'persisted', true,
    'credential_generation', v_new_gen,
    'access_token_expires_at', p_expires_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.complete_revolut_business_oauth_refresh(uuid, bigint, text, timestamptz, text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_revolut_business_oauth_refresh(uuid, bigint, text, timestamptz, text, text, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_revolut_business_oauth_refresh(uuid, bigint, text, timestamptz, text, text, text, text) TO service_role;

-- ── fail ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.fail_revolut_business_oauth_refresh(
  p_claim_token uuid,
  p_error_code text,
  p_provider text DEFAULT 'revolut',
  p_environment text DEFAULT 'live'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_now timestamptz := now();
  v_row public.revolut_business_oauth_refresh_coord%ROWTYPE;
  v_safe text;
BEGIN
  IF p_claim_token IS NULL THEN
    RAISE EXCEPTION 'claim_token_required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  v_safe := left(regexp_replace(coalesce(p_error_code, 'refresh_failed'), '[^A-Za-z0-9_.:-]', '', 'g'), 120);
  IF v_safe = '' THEN
    v_safe := 'refresh_failed';
  END IF;

  SELECT * INTO v_row
  FROM public.revolut_business_oauth_refresh_coord c
  WHERE c.provider = p_provider
    AND c.environment = p_environment
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'COORD_MISSING', 'cleared', false);
  END IF;

  IF v_row.refresh_claim_token IS DISTINCT FROM p_claim_token THEN
    RETURN jsonb_build_object(
      'status', 'CLAIM_MISMATCH',
      'cleared', false,
      'credential_generation', v_row.credential_generation
    );
  END IF;

  UPDATE public.revolut_business_oauth_refresh_coord c
  SET
    refresh_claim_token = NULL,
    refresh_claimed_at = NULL,
    refresh_claim_expires_at = NULL,
    last_refresh_error_code = v_safe,
    updated_at = v_now
  WHERE c.provider = p_provider
    AND c.environment = p_environment
    AND c.refresh_claim_token = p_claim_token;

  RETURN jsonb_build_object(
    'status', 'FAILED',
    'cleared', true,
    'error_code', v_safe,
    'credential_generation', v_row.credential_generation,
    'access_token_expires_at', v_row.access_token_expires_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fail_revolut_business_oauth_refresh(uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fail_revolut_business_oauth_refresh(uuid, text, text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_revolut_business_oauth_refresh(uuid, text, text, text) TO service_role;

COMMENT ON FUNCTION public.claim_revolut_business_oauth_refresh IS
  'Claim Revolut Business OAuth refresh under FOR UPDATE. Returns CLAIMED / '
  'TOKEN_ALREADY_FRESH / REFRESH_IN_PROGRESS. Never returns secrets. service_role only.';

COMMENT ON FUNCTION public.complete_revolut_business_oauth_refresh IS
  'CAS-complete OAuth refresh: matching claim_token + expected generation required. '
  'Persists vault secrets, increments generation, clears claim. Stale claimants cannot overwrite.';

COMMENT ON FUNCTION public.fail_revolut_business_oauth_refresh IS
  'Clear matching refresh claim and store redacted error. Never mutates vault credentials.';
