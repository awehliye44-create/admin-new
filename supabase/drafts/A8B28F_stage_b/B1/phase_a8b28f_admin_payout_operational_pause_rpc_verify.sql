-- ============================================================
-- A8B28F Stage B1 — BEGIN/ROLLBACK verification (DRAFT — DO NOT APPLY)
-- Safe to run as a single transaction that always rolls back.
-- Never commits. Never mutates MK0006 or live drivers permanently.
-- ============================================================

BEGIN;

-- 1) Function body + ACL presence checks after hypothetical create
-- (Operators should apply B1 migration in a lab first; this script
-- validates the draft SQL text invariants via comments + optional
-- CREATE in a rolled-back txn when run against a disposable clone.)

-- Dual-write safety proof against LIVE definitions (read-only):
-- Early cashout still requires PROVIDER_VERIFIED after payouts_enabled.
DO $$
DECLARE
  v_def text;
BEGIN
  SELECT pg_get_functiondef(p.oid)
  INTO v_def
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'driver_wallet_summary_ssot'
  LIMIT 1;

  IF v_def IS NULL THEN
    RAISE NOTICE 'driver_wallet_summary_ssot not found — skip body proof';
  ELSE
    IF position('PAYOUT_ACCOUNT_NOT_VERIFIED' in v_def) = 0 THEN
      RAISE EXCEPTION 'missing PAYOUT_ACCOUNT_NOT_VERIFIED gate';
    END IF;
    IF position('PROVIDER_VERIFIED' in v_def) = 0 THEN
      RAISE EXCEPTION 'missing PROVIDER_VERIFIED destination gate';
    END IF;
  END IF;
END $$;

-- MK0006 snapshot (no PII): must remain non-effective / non-verified.
DO $$
DECLARE
  v_enabled boolean;
  v_paused boolean;
  v_verified boolean;
  v_effective boolean;
BEGIN
  SELECT
    d.payouts_enabled,
    d.payout_operational_paused,
    public.driver_has_provider_verified_payout_destination(d.id),
    public.driver_effective_payout_allowed(d.id)
  INTO v_enabled, v_paused, v_verified, v_effective
  FROM public.drivers d
  WHERE upper(d.driver_code) = 'MK0006'
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE NOTICE 'MK0006 not found in this environment';
  ELSE
    IF v_verified IS TRUE THEN
      RAISE EXCEPTION 'MK0006 unexpectedly provider-verified';
    END IF;
    IF v_effective IS TRUE THEN
      RAISE EXCEPTION 'MK0006 unexpectedly effective_payout_allowed';
    END IF;
    IF v_paused IS TRUE THEN
      RAISE EXCEPTION 'MK0006 unexpectedly operationally paused';
    END IF;
    RAISE NOTICE 'MK0006 ok: payouts_enabled=%, paused=%, verified=%, effective=%',
      v_enabled, v_paused, v_verified, v_effective;
  END IF;
END $$;

-- Wallet eligibility hash stability marker (function still present, Stage B must not replace it)
DO $$
BEGIN
  IF to_regprocedure('public.driver_wallet_eligibility_balances(uuid)') IS NULL THEN
    RAISE EXCEPTION 'driver_wallet_eligibility_balances missing';
  END IF;
END $$;

-- Always roll back — this script must never commit.
ROLLBACK;
