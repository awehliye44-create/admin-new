-- Non-committing verification for 20261107130000_phase2a_anon_secdef_execute_revoke_lock.sql
-- Applies grant revokes in a transaction, runs role matrix, then ROLLBACK.
-- NEVER COMMIT. Does not send campaign notifications (requires due rows + HTTP).

\set ON_ERROR_STOP on
\pset pager off

BEGIN;

-- Snapshot baseline privileges (must restore on ROLLBACK automatically).
CREATE TEMP TABLE _baseline_priv AS
SELECT
  'campaign_heads_up_due_sweep'::text AS fn,
  has_function_privilege('anon', 'public.campaign_heads_up_due_sweep()', 'EXECUTE') AS anon_x,
  has_function_privilege('authenticated', 'public.campaign_heads_up_due_sweep()', 'EXECUTE') AS auth_x,
  has_function_privilege('service_role', 'public.campaign_heads_up_due_sweep()', 'EXECUTE') AS svc_x,
  has_function_privilege('postgres', 'public.campaign_heads_up_due_sweep()', 'EXECUTE') AS pg_x
UNION ALL
SELECT
  'check_identity_exists',
  has_function_privilege('anon', 'public.check_identity_exists(text, text)', 'EXECUTE'),
  has_function_privilege('authenticated', 'public.check_identity_exists(text, text)', 'EXECUTE'),
  has_function_privilege('service_role', 'public.check_identity_exists(text, text)', 'EXECUTE'),
  has_function_privilege('postgres', 'public.check_identity_exists(text, text)', 'EXECUTE');

-- Fail closed if campaigns are due — calling postgres path would enqueue HTTP.
DO $$
DECLARE
  v_due int;
BEGIN
  SELECT count(*)::int INTO v_due
  FROM public.campaign_heads_up_campaigns c
  WHERE c.status = 'scheduled'
    AND (
      c.ends_at IS NOT NULL AND c.ends_at <= now()
      OR coalesce(c.scheduled_at, c.starts_at) IS NOT NULL
         AND coalesce(c.scheduled_at, c.starts_at) <= now()
    );
  IF v_due > 0 THEN
    RAISE EXCEPTION 'VERIFY ABORT: % due campaign(s) — refusing live sweep call', v_due;
  END IF;
END $$;

-- Apply Phase 2A grants (same SQL as migration body).
REVOKE ALL ON FUNCTION public.campaign_heads_up_due_sweep() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.campaign_heads_up_due_sweep() FROM anon;
REVOKE ALL ON FUNCTION public.campaign_heads_up_due_sweep() FROM authenticated;
REVOKE ALL ON FUNCTION public.campaign_heads_up_due_sweep() FROM service_role;

REVOKE ALL ON FUNCTION public.check_identity_exists(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_identity_exists(text, text) FROM anon;
REVOKE ALL ON FUNCTION public.check_identity_exists(text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.check_identity_exists(text, text) TO service_role;

-- Privilege matrix assertions.
DO $$
BEGIN
  -- Campaign: no API roles
  IF has_function_privilege('anon', 'public.campaign_heads_up_due_sweep()', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAIL: anon still EXECUTE on campaign_heads_up_due_sweep';
  END IF;
  IF has_function_privilege('authenticated', 'public.campaign_heads_up_due_sweep()', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAIL: authenticated still EXECUTE on campaign_heads_up_due_sweep';
  END IF;
  IF has_function_privilege('service_role', 'public.campaign_heads_up_due_sweep()', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAIL: service_role still EXECUTE on campaign_heads_up_due_sweep';
  END IF;
  IF NOT has_function_privilege('postgres', 'public.campaign_heads_up_due_sweep()', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAIL: postgres lost EXECUTE on campaign_heads_up_due_sweep (cron would break)';
  END IF;
  -- PUBLIC must not retain EXECUTE (indirect anon restore).
  IF has_function_privilege('public', 'public.campaign_heads_up_due_sweep()', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAIL: PUBLIC still EXECUTE on campaign_heads_up_due_sweep';
  END IF;

  -- Identity: service_role only among API roles
  IF has_function_privilege('anon', 'public.check_identity_exists(text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAIL: anon still EXECUTE on check_identity_exists';
  END IF;
  IF has_function_privilege('authenticated', 'public.check_identity_exists(text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAIL: authenticated still EXECUTE on check_identity_exists';
  END IF;
  IF has_function_privilege('public', 'public.check_identity_exists(text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAIL: PUBLIC still EXECUTE on check_identity_exists';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.check_identity_exists(text, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'VERIFY FAIL: service_role missing EXECUTE on check_identity_exists';
  END IF;
END $$;

-- Runtime probes as each role.
DO $$
DECLARE
  v_json jsonb;
  v_err text;
BEGIN
  -- anon: campaign denied
  BEGIN
    SET LOCAL ROLE anon;
    PERFORM public.campaign_heads_up_due_sweep();
    RESET ROLE;
    RAISE EXCEPTION 'VERIFY FAIL: anon executed campaign_heads_up_due_sweep';
  EXCEPTION
    WHEN insufficient_privilege THEN RESET ROLE;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      RESET ROLE;
      IF SQLSTATE = '42501' THEN NULL;
      ELSE RAISE EXCEPTION 'VERIFY FAIL anon campaign unexpected: % %', SQLSTATE, v_err;
      END IF;
  END;

  -- authenticated: campaign denied
  BEGIN
    SET LOCAL ROLE authenticated;
    PERFORM public.campaign_heads_up_due_sweep();
    RESET ROLE;
    RAISE EXCEPTION 'VERIFY FAIL: authenticated executed campaign_heads_up_due_sweep';
  EXCEPTION
    WHEN insufficient_privilege THEN RESET ROLE;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      RESET ROLE;
      IF SQLSTATE = '42501' THEN NULL;
      ELSE RAISE EXCEPTION 'VERIFY FAIL auth campaign unexpected: % %', SQLSTATE, v_err;
      END IF;
  END;

  -- postgres (cron role): early-return with 0 due — no HTTP
  PERFORM public.campaign_heads_up_due_sweep();

  -- anon: identity denied
  BEGIN
    SET LOCAL ROLE anon;
    SELECT public.check_identity_exists('+10000000000', 'phase2a-probe@example.invalid') INTO v_json;
    RESET ROLE;
    RAISE EXCEPTION 'VERIFY FAIL: anon executed check_identity_exists → %', v_json;
  EXCEPTION
    WHEN insufficient_privilege THEN RESET ROLE;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      RESET ROLE;
      IF SQLSTATE = '42501' THEN NULL;
      ELSE RAISE EXCEPTION 'VERIFY FAIL anon identity unexpected: % %', SQLSTATE, v_err;
      END IF;
  END;

  -- authenticated: identity denied
  BEGIN
    SET LOCAL ROLE authenticated;
    SELECT public.check_identity_exists('+10000000000', 'phase2a-probe@example.invalid') INTO v_json;
    RESET ROLE;
    RAISE EXCEPTION 'VERIFY FAIL: authenticated executed check_identity_exists → %', v_json;
  EXCEPTION
    WHEN insufficient_privilege THEN RESET ROLE;
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      RESET ROLE;
      IF SQLSTATE = '42501' THEN NULL;
      ELSE RAISE EXCEPTION 'VERIFY FAIL auth identity unexpected: % %', SQLSTATE, v_err;
      END IF;
  END;

  -- service_role: identity works
  BEGIN
    SET LOCAL ROLE service_role;
    SELECT public.check_identity_exists('+10000000000', 'phase2a-probe@example.invalid') INTO v_json;
    RESET ROLE;
    IF v_json IS NULL OR NOT (v_json ? 'phone_exists') OR NOT (v_json ? 'email_exists') THEN
      RAISE EXCEPTION 'VERIFY FAIL: service_role identity bad shape %', v_json;
    END IF;
    IF (v_json->>'phone_exists')::boolean IS DISTINCT FROM false
       OR (v_json->>'email_exists')::boolean IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'VERIFY FAIL: unexpected existence flags %', v_json;
    END IF;
  EXCEPTION
    WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
      RESET ROLE;
      RAISE EXCEPTION 'VERIFY FAIL service_role identity: % %', SQLSTATE, v_err;
  END;

  -- Cron job still present and postgres-owned
  IF NOT EXISTS (
    SELECT 1 FROM cron.job
    WHERE jobname = 'campaign-heads-up-due-sweep'
      AND active
      AND username = 'postgres'
      AND command ILIKE '%campaign_heads_up_due_sweep%'
  ) THEN
    RAISE EXCEPTION 'VERIFY FAIL: campaign-heads-up-due-sweep cron missing/inactive/wrong user';
  END IF;
END $$;

SELECT 'PHASE2A_VERIFY_OK' AS status;
SELECT * FROM _baseline_priv;

ROLLBACK;
SELECT 'PHASE2A_VERIFY_ROLLED_BACK' AS status;
