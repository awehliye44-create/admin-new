-- Read-only structural contract checks for SA-rule document eligibility SSOT.
-- Per-scenario behaviour lives in driver_document_eligibility_scenarios.sql.

BEGIN;

DO $$
DECLARE
  v_definition text;
  v_viewdef text;
BEGIN
  SELECT pg_get_functiondef(p.oid)
  INTO v_definition
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = 'get_driver_document_eligibility';

  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'get_driver_document_eligibility missing';
  END IF;

  IF v_definition !~ 'blocking_documents'
     OR v_definition !~ 'blocking_reason'
     OR v_definition !~ '''eligible'''
  THEN
    RAISE EXCEPTION 'eligibility payload missing blocking_documents/blocking_reason/eligible';
  END IF;

  IF v_definition !~ 'expiry_required_but_missing' THEN
    RAISE EXCEPTION 'eligibility must distinguish expiry_required_but_missing';
  END IF;

  -- Mandatory eligibility WHERE clause must not require display_in_driver_app.
  IF v_definition ~* 'sar\.mandatory = true[[:space:]]+AND[[:space:]]+COALESCE\(sar\.display_in_driver_app'
     OR v_definition ~* 'display_in_driver_app, true\) = true[[:space:]]+AND[[:space:]]+sar\.mandatory'
  THEN
    RAISE EXCEPTION 'mandatory eligibility must ignore display_in_driver_app';
  END IF;

  IF v_definition !~ 'sar\.is_active = true'
     OR v_definition !~ 'sar\.mandatory = true'
  THEN
    RAISE EXCEPTION 'eligibility must require active + mandatory SA rules';
  END IF;

  IF v_definition !~ 'v_expiry_required THEN' THEN
    RAISE EXCEPTION 'expiry checks must be gated by expiry_required';
  END IF;

  SELECT pg_get_viewdef('public.driver_document_compliance_ssot'::regclass, true)
  INTO v_viewdef;

  IF v_viewdef IS NULL OR v_viewdef !~ 'service_area_document_rules' THEN
    RAISE EXCEPTION 'compliance view must use service_area_document_rules';
  END IF;

  IF v_viewdef ~ 'CROSS JOIN document_types' THEN
    RAISE EXCEPTION 'compliance view must not CROSS JOIN document_types';
  END IF;
END;
$$;

ROLLBACK;
