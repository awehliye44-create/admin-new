-- Isolated scenario coverage for service-area document eligibility.
-- Each scenario runs in a dedicated service area with exactly one rule, so the
-- assertions cannot be masked by pre-existing rules in a shared service area.

BEGIN;

-- guard_driver_document_writes forces every non-admin write to 'pending'.
-- Probes model admin review outcomes, so run the fixtures as service_role.
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT set_config('request.jwt.claim.role', 'service_role', true);

CREATE OR REPLACE FUNCTION pg_temp.probe_service_area() RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_sa uuid;
  v_tag text := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
  v_src record;
BEGIN
  SELECT region_id, geo_boundary, center_lat, center_lng, country, timezone
  INTO v_src
  FROM public.service_areas
  WHERE geo_boundary IS NOT NULL AND region_id IS NOT NULL
  ORDER BY created_at NULLS LAST
  LIMIT 1;

  IF v_src IS NULL THEN
    RAISE EXCEPTION 'No service area with a geo boundary available to clone';
  END IF;

  INSERT INTO public.service_areas (
    name, region_id, is_active, geo_boundary, center_lat, center_lng,
    country, timezone, trip_id_prefix, driver_id_prefix, driver_signup_enabled
  )
  VALUES (
    'Probe ' || v_tag, v_src.region_id, true, v_src.geo_boundary,
    v_src.center_lat, v_src.center_lng, v_src.country, v_src.timezone,
    'PT' || v_tag, 'PD' || v_tag, true
  )
  RETURNING id INTO v_sa;

  RETURN v_sa;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.probe_driver(p_sa uuid) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_user uuid := gen_random_uuid();
  v_driver uuid;
  v_region uuid;
  v_tag text := substr(replace(v_user::text, '-', ''), 1, 10);
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

  SELECT region_id INTO v_region FROM public.service_areas WHERE id = p_sa;

  INSERT INTO public.drivers (
    id, user_id, service_area_id, region_id, approval_status, driver_status,
    documents_approved, first_name, last_name, email, phone
  )
  VALUES (
    gen_random_uuid(), v_user, p_sa, v_region, 'approved', 'active',
    false, 'Probe', 'Driver', 'probe_' || v_tag || '@example.test', '+4470' || v_tag
  )
  RETURNING id INTO v_driver;

  RETURN v_driver;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.probe_doc_type() RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.document_types (id, slug, name, is_active, is_required, has_expiry)
  VALUES (
    gen_random_uuid(),
    'probe_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12),
    'Probe Document',
    true, true, true
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION pg_temp.probe_upload(
  p_driver uuid, p_type uuid, p_status text, p_expiry date
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_slug text;
  v_id uuid;
BEGIN
  SELECT slug INTO v_slug FROM public.document_types WHERE id = p_type;
  INSERT INTO public.documents (
    driver_id, document_type, document_type_id, document_name,
    status, expiry_date, is_current
  )
  VALUES (p_driver, v_slug, p_type, 'Probe Document', p_status, p_expiry, true)
  RETURNING id INTO v_id;
END;
$$;

DO $$
DECLARE
  v_sa uuid;
  v_driver uuid;
  v_type uuid;
  v_rule uuid;
  v_r jsonb;
BEGIN
  ----------------------------------------------------------------------------
  -- 1. active + mandatory + expiry_required + expired  -> blocked, redirected
  ----------------------------------------------------------------------------
  v_sa := pg_temp.probe_service_area();
  v_driver := pg_temp.probe_driver(v_sa);
  v_type := pg_temp.probe_doc_type();
  INSERT INTO public.service_area_document_rules
    (service_area_id, doc_type_id, mandatory, expiry_required, display_in_driver_app, is_active)
  VALUES (v_sa, v_type, true, true, true, true);
  PERFORM pg_temp.probe_upload(v_driver, v_type, 'approved', CURRENT_DATE - 1);

  v_r := public.get_driver_document_eligibility(v_driver);
  IF (v_r->>'eligible')::boolean <> false
     OR (v_r->>'blocking_reason') <> 'document_expired'
     OR (v_r->>'should_open_documents')::boolean <> true
     OR jsonb_array_length(v_r->'blocking_documents') <> 1 THEN
    RAISE EXCEPTION 'scenario 1 (expired mandatory) failed: %', v_r;
  END IF;

  ----------------------------------------------------------------------------
  -- 2. active + mandatory + expiry_required + NULL expiry -> blocked
  ----------------------------------------------------------------------------
  v_sa := pg_temp.probe_service_area();
  v_driver := pg_temp.probe_driver(v_sa);
  v_type := pg_temp.probe_doc_type();
  INSERT INTO public.service_area_document_rules
    (service_area_id, doc_type_id, mandatory, expiry_required, display_in_driver_app, is_active)
  VALUES (v_sa, v_type, true, true, true, true);
  PERFORM pg_temp.probe_upload(v_driver, v_type, 'approved', NULL);

  v_r := public.get_driver_document_eligibility(v_driver);
  IF (v_r->>'eligible')::boolean <> false
     OR (v_r->>'blocking_reason') <> 'expiry_required_but_missing' THEN
    RAISE EXCEPTION 'scenario 2 (missing expiry) failed: %', v_r;
  END IF;

  ----------------------------------------------------------------------------
  -- 3. active + mandatory + expiry_required=false + approved + NULL expiry -> allowed
  ----------------------------------------------------------------------------
  v_sa := pg_temp.probe_service_area();
  v_driver := pg_temp.probe_driver(v_sa);
  v_type := pg_temp.probe_doc_type();
  INSERT INTO public.service_area_document_rules
    (service_area_id, doc_type_id, mandatory, expiry_required, display_in_driver_app, is_active)
  VALUES (v_sa, v_type, true, false, true, true);
  PERFORM pg_temp.probe_upload(v_driver, v_type, 'approved', NULL);

  v_r := public.get_driver_document_eligibility(v_driver);
  IF (v_r->>'eligible')::boolean <> true
     OR jsonb_array_length(v_r->'blocking_documents') <> 0 THEN
    RAISE EXCEPTION 'scenario 3 (no expiry required) failed: %', v_r;
  END IF;

  -- A stale expiry date on a rule that does not require expiry is still ignored.
  v_sa := pg_temp.probe_service_area();
  v_driver := pg_temp.probe_driver(v_sa);
  v_type := pg_temp.probe_doc_type();
  INSERT INTO public.service_area_document_rules
    (service_area_id, doc_type_id, mandatory, expiry_required, display_in_driver_app, is_active)
  VALUES (v_sa, v_type, true, false, true, true);
  PERFORM pg_temp.probe_upload(v_driver, v_type, 'approved', CURRENT_DATE - 500);

  v_r := public.get_driver_document_eligibility(v_driver);
  IF (v_r->>'eligible')::boolean <> true THEN
    RAISE EXCEPTION 'scenario 3b (expiry ignored when not required) failed: %', v_r;
  END IF;

  ----------------------------------------------------------------------------
  -- 4. active + optional + expired upload -> allowed
  ----------------------------------------------------------------------------
  v_sa := pg_temp.probe_service_area();
  v_driver := pg_temp.probe_driver(v_sa);
  v_type := pg_temp.probe_doc_type();
  INSERT INTO public.service_area_document_rules
    (service_area_id, doc_type_id, mandatory, expiry_required, display_in_driver_app, is_active)
  VALUES (v_sa, v_type, false, true, true, true);
  PERFORM pg_temp.probe_upload(v_driver, v_type, 'approved', CURRENT_DATE - 30);

  v_r := public.get_driver_document_eligibility(v_driver);
  IF (v_r->>'eligible')::boolean <> true
     OR jsonb_array_length(v_r->'blocking_documents') <> 0 THEN
    RAISE EXCEPTION 'scenario 4 (optional expired) failed: %', v_r;
  END IF;

  ----------------------------------------------------------------------------
  -- 5. inactive rule + expired upload -> allowed
  ----------------------------------------------------------------------------
  v_sa := pg_temp.probe_service_area();
  v_driver := pg_temp.probe_driver(v_sa);
  v_type := pg_temp.probe_doc_type();
  INSERT INTO public.service_area_document_rules
    (service_area_id, doc_type_id, mandatory, expiry_required, display_in_driver_app, is_active)
  VALUES (v_sa, v_type, true, true, true, false);
  PERFORM pg_temp.probe_upload(v_driver, v_type, 'approved', CURRENT_DATE - 30);

  v_r := public.get_driver_document_eligibility(v_driver);
  IF (v_r->>'document_status') <> 'rules_not_configured' THEN
    RAISE EXCEPTION 'scenario 5 expected no active rules: %', v_r;
  END IF;
  IF jsonb_array_length(v_r->'blocking_documents') <> 0
     OR (v_r->>'should_open_documents')::boolean <> false THEN
    RAISE EXCEPTION 'scenario 5 (inactive rule) must not block on documents: %', v_r;
  END IF;

  ----------------------------------------------------------------------------
  -- 6. hidden but mandatory -> eligibility still follows mandatory
  ----------------------------------------------------------------------------
  v_sa := pg_temp.probe_service_area();
  v_driver := pg_temp.probe_driver(v_sa);
  v_type := pg_temp.probe_doc_type();
  INSERT INTO public.service_area_document_rules
    (service_area_id, doc_type_id, mandatory, expiry_required, display_in_driver_app, is_active)
  VALUES (v_sa, v_type, true, false, false, true);

  v_r := public.get_driver_document_eligibility(v_driver);
  IF (v_r->>'eligible')::boolean <> false
     OR (v_r->>'blocking_reason') <> 'missing_required_document' THEN
    RAISE EXCEPTION 'scenario 6 (hidden mandatory) failed: %', v_r;
  END IF;

  PERFORM pg_temp.probe_upload(v_driver, v_type, 'approved', NULL);
  v_r := public.get_driver_document_eligibility(v_driver);
  IF (v_r->>'eligible')::boolean <> true THEN
    RAISE EXCEPTION 'scenario 6b (hidden mandatory satisfied) failed: %', v_r;
  END IF;

  ----------------------------------------------------------------------------
  -- 7. admin removes the requirement -> eligible immediately, no re-upload
  ----------------------------------------------------------------------------
  v_sa := pg_temp.probe_service_area();
  v_driver := pg_temp.probe_driver(v_sa);
  v_type := pg_temp.probe_doc_type();
  INSERT INTO public.service_area_document_rules
    (service_area_id, doc_type_id, mandatory, expiry_required, display_in_driver_app, is_active)
  VALUES (v_sa, v_type, true, true, true, true)
  RETURNING id INTO v_rule;
  PERFORM pg_temp.probe_upload(v_driver, v_type, 'approved', CURRENT_DATE - 5);

  v_r := public.get_driver_document_eligibility(v_driver);
  IF (v_r->>'eligible')::boolean <> false THEN
    RAISE EXCEPTION 'scenario 7 precondition (expired) failed: %', v_r;
  END IF;

  UPDATE public.service_area_document_rules SET mandatory = false WHERE id = v_rule;

  v_r := public.get_driver_document_eligibility(v_driver);
  IF (v_r->>'eligible')::boolean <> true
     OR jsonb_array_length(v_r->'blocking_documents') <> 0 THEN
    RAISE EXCEPTION 'scenario 7 (requirement removed) failed: %', v_r;
  END IF;

  -- Cached column used by dispatch must follow without a nightly sweep.
  IF (SELECT documents_approved FROM public.drivers WHERE id = v_driver) <> true THEN
    RAISE EXCEPTION 'scenario 7 did not refresh drivers.documents_approved';
  END IF;

  ----------------------------------------------------------------------------
  -- 8. newly mandatory document missing -> blocked with redirect
  ----------------------------------------------------------------------------
  v_sa := pg_temp.probe_service_area();
  v_driver := pg_temp.probe_driver(v_sa);
  v_type := pg_temp.probe_doc_type();
  INSERT INTO public.service_area_document_rules
    (service_area_id, doc_type_id, mandatory, expiry_required, display_in_driver_app, is_active)
  VALUES (v_sa, v_type, false, true, true, true)
  RETURNING id INTO v_rule;

  v_r := public.get_driver_document_eligibility(v_driver);
  IF (v_r->>'eligible')::boolean <> true THEN
    RAISE EXCEPTION 'scenario 8 precondition (optional missing) failed: %', v_r;
  END IF;

  UPDATE public.service_area_document_rules SET mandatory = true WHERE id = v_rule;

  v_r := public.get_driver_document_eligibility(v_driver);
  IF (v_r->>'eligible')::boolean <> false
     OR (v_r->>'blocking_reason') <> 'missing_required_document'
     OR (v_r->>'should_open_documents')::boolean <> true THEN
    RAISE EXCEPTION 'scenario 8 (newly mandatory) failed: %', v_r;
  END IF;

  ----------------------------------------------------------------------------
  -- 9. pending / rejected mandatory uploads block with their own reasons
  ----------------------------------------------------------------------------
  v_sa := pg_temp.probe_service_area();
  v_driver := pg_temp.probe_driver(v_sa);
  v_type := pg_temp.probe_doc_type();
  INSERT INTO public.service_area_document_rules
    (service_area_id, doc_type_id, mandatory, expiry_required, display_in_driver_app, is_active)
  VALUES (v_sa, v_type, true, true, true, true);
  PERFORM pg_temp.probe_upload(v_driver, v_type, 'pending', CURRENT_DATE + 90);

  v_r := public.get_driver_document_eligibility(v_driver);
  IF (v_r->>'blocking_reason') <> 'document_pending' THEN
    RAISE EXCEPTION 'scenario 9 (pending) failed: %', v_r;
  END IF;

  UPDATE public.documents SET status = 'rejected'
  WHERE driver_id = v_driver AND document_type_id = v_type;

  v_r := public.get_driver_document_eligibility(v_driver);
  IF (v_r->>'blocking_reason') <> 'document_rejected' THEN
    RAISE EXCEPTION 'scenario 9b (rejected) failed: %', v_r;
  END IF;

  ----------------------------------------------------------------------------
  -- 10. admin-disabled account is not a document problem
  ----------------------------------------------------------------------------
  v_sa := pg_temp.probe_service_area();
  v_driver := pg_temp.probe_driver(v_sa);
  v_type := pg_temp.probe_doc_type();
  INSERT INTO public.service_area_document_rules
    (service_area_id, doc_type_id, mandatory, expiry_required, display_in_driver_app, is_active)
  VALUES (v_sa, v_type, true, false, true, true);
  PERFORM pg_temp.probe_upload(v_driver, v_type, 'approved', NULL);

  UPDATE public.drivers SET driver_status = 'disabled' WHERE id = v_driver;

  v_r := public.get_driver_document_eligibility(v_driver);
  IF (v_r->>'eligible')::boolean <> true
     OR jsonb_array_length(v_r->'blocking_documents') <> 0
     OR (v_r->>'should_open_documents')::boolean <> false THEN
    RAISE EXCEPTION 'scenario 10 (admin disabled) must stay document-clean: %', v_r;
  END IF;
END;
$$;

ROLLBACK;
