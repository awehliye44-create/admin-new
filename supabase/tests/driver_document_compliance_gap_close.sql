-- Contract checks for the document-compliance gap close:
--  * config states (no service area / no rules) are not document blockers
--  * should_open_documents tracks blocking_documents only
--  * SA rule changes recalc through recalculate_driver_documents_approved
--  * daily sweep recomputes stale documents_approved in both directions

BEGIN;

DO $$
DECLARE
  v_elig text;
  v_trig text;
  v_cron text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_elig
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = 'get_driver_document_eligibility';

  -- Redirect signal must be derived from actionable documents, never from eligible=false.
  IF v_elig !~ 'should_open_documents'', \(jsonb_array_length\(v_blocking_docs\) > 0\)' THEN
    RAISE EXCEPTION 'should_open_documents must be driven by blocking_documents';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_trig
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = 'recalc_drivers_on_sa_rule_change';

  IF v_trig IS NULL THEN
    RAISE EXCEPTION 'recalc_drivers_on_sa_rule_change missing';
  END IF;

  -- Direct is_online writes bypass the availability guard and drop online intent.
  IF v_trig ~* 'UPDATE public\.drivers' OR v_trig !~ 'recalculate_driver_documents_approved' THEN
    RAISE EXCEPTION 'SA rule recalc must delegate to recalculate_driver_documents_approved';
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO v_cron
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace
    AND p.proname = 'recalculate_drivers_compliance_london_daily';

  -- Old prefilter only saw already-approved/online drivers and expiry_date < today,
  -- so it missed expiry_required-with-NULL-expiry and never re-enabled drivers.
  IF v_cron ~ 'expiry_date IS NOT NULL' OR v_cron ~ 'documents_approved = true' THEN
    RAISE EXCEPTION 'daily sweep must not prefilter on expiry_date / documents_approved';
  END IF;

  IF v_cron !~ 'IS DISTINCT FROM COALESCE\(d\.documents_approved, false\)' THEN
    RAISE EXCEPTION 'daily sweep must recompute stale documents_approved in both directions';
  END IF;
END;
$$;

-- Shared probe fixture. Drivers require a verified auth user and a region.
CREATE OR REPLACE FUNCTION pg_temp.probe_user() RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_user uuid := gen_random_uuid();
  v_tag text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);
BEGIN
  INSERT INTO auth.users (
    id, instance_id, aud, role, email, phone,
    email_confirmed_at, phone_confirmed_at, created_at, updated_at
  )
  VALUES (
    v_user, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    'probe_' || v_tag || '@example.test', '+4470' || v_tag,
    now(), now(), now(), now()
  );
  RETURN v_user;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.probe_driver(p_sa uuid) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_user uuid := pg_temp.probe_user();
  v_driver uuid;
  v_region uuid;
  v_sa uuid := p_sa;
  v_tag text := substr(replace(v_user::text, '-', ''), 1, 10);
BEGIN
  -- Driver code allocation requires a service area at insert time, so the
  -- "unassigned" state is reached by clearing it afterwards.
  IF v_sa IS NULL THEN
    SELECT id INTO v_sa
    FROM public.service_areas
    WHERE is_active = true AND region_id IS NOT NULL
    ORDER BY created_at NULLS LAST
    LIMIT 1;
  END IF;

  SELECT region_id INTO v_region FROM public.service_areas WHERE id = v_sa;

  INSERT INTO public.drivers (
    id, user_id, service_area_id, region_id, approval_status, driver_status,
    documents_approved, first_name, last_name, email, phone
  )
  VALUES (
    gen_random_uuid(), v_user, v_sa, v_region, 'approved', 'active',
    false, 'Probe', 'Driver', 'probe_' || v_tag || '@example.test', '+4470' || v_tag
  )
  RETURNING id INTO v_driver;

  IF p_sa IS NULL THEN
    UPDATE public.drivers SET service_area_id = NULL WHERE id = v_driver;
  END IF;

  RETURN v_driver;
END;
$$;

-- Behavioural: config states must not request a My Documents redirect.
DO $$
DECLARE
  v_driver uuid;
  v_result jsonb;
BEGIN
  v_driver := pg_temp.probe_driver(NULL);
  v_result := public.get_driver_document_eligibility(v_driver);

  IF (v_result->>'document_status') IS DISTINCT FROM 'service_area_not_assigned' THEN
    RAISE EXCEPTION 'expected service_area_not_assigned: %', v_result;
  END IF;

  IF COALESCE((v_result->>'eligible')::boolean, true) <> false THEN
    RAISE EXCEPTION 'unassigned service area must stay ineligible: %', v_result;
  END IF;

  IF (v_result->>'blocking_reason') IS NOT NULL THEN
    RAISE EXCEPTION 'no service area is not a document blocking reason: %', v_result;
  END IF;

  IF jsonb_array_length(COALESCE(v_result->'blocking_documents', '[]'::jsonb)) <> 0 THEN
    RAISE EXCEPTION 'no service area must not list blocking documents: %', v_result;
  END IF;

  IF COALESCE((v_result->>'should_open_documents')::boolean, true) <> false THEN
    RAISE EXCEPTION 'no service area must not open My Documents: %', v_result;
  END IF;
END;
$$;

-- Behavioural: toggling an SA rule while a driver is online must not trip the
-- availability write guard, and must preserve driver_online_intent.
DO $$
DECLARE
  v_sa uuid;
  v_driver uuid;
  v_type uuid;
  v_rule uuid;
  v_intent boolean;
BEGIN
  SELECT id INTO v_sa
  FROM public.service_areas
  WHERE is_active = true AND region_id IS NOT NULL
  ORDER BY created_at NULLS LAST
  LIMIT 1;

  IF v_sa IS NULL THEN
    RAISE EXCEPTION 'No active service area available for rule-toggle probe';
  END IF;

  INSERT INTO public.document_types (id, slug, name, is_active, is_required, has_expiry)
  VALUES (
    gen_random_uuid(),
    'probe_toggle_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 8),
    'Probe Toggle',
    true, true, true
  )
  RETURNING id INTO v_type;

  INSERT INTO public.service_area_document_rules (
    service_area_id, doc_type_id, mandatory, expiry_required, display_in_driver_app, is_active, sort_order
  )
  VALUES (v_sa, v_type, true, true, true, true, 9101)
  RETURNING id INTO v_rule;

  v_driver := pg_temp.probe_driver(v_sa);

  PERFORM public.allow_driver_availability_write();
  UPDATE public.drivers
  SET driver_online_intent = true, is_online = true
  WHERE id = v_driver;

  -- Would previously raise DIRECT_AVAILABILITY_WRITE_FORBIDDEN and abort the admin edit.
  UPDATE public.service_area_document_rules
  SET mandatory = false
  WHERE id = v_rule;

  UPDATE public.service_area_document_rules
  SET is_active = false
  WHERE id = v_rule;

  SELECT driver_online_intent INTO v_intent
  FROM public.drivers WHERE id = v_driver;

  IF COALESCE(v_intent, false) <> true THEN
    RAISE EXCEPTION 'SA rule change must preserve driver_online_intent, got %', v_intent;
  END IF;
END;
$$;

ROLLBACK;
