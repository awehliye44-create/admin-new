-- Driver vehicle change request flow.
--
-- A driver with an approved vehicle submits new vehicle details. The request is
-- `pending` until an admin approves or rejects it; the approved vehicle stays
-- active and unchanged meanwhile. Approval applies the details atomically after
-- the applicable vehicle documents have been reviewed and the driver's vehicle
-- categories have been rechecked. Rejection leaves the vehicle untouched.
--
-- Rules:
--  * Every write goes through SECURITY DEFINER RPCs. Drivers and admins have no
--    direct INSERT/UPDATE/DELETE on vehicle_change_requests.
--  * The vehicle is resolved server-side from the caller's own driver row
--    (ownership), never taken from the client.
--  * Submissions are always created `pending`; at most one pending request per
--    driver (partial unique index).
--  * Decided rows (approved / rejected / cancelled) are final.
--  * submit NEVER writes drivers.vehicle_edit_request_status = 'pending':
--    assert_driver_presence_online_eligible blocks going online on that value,
--    and the approved vehicle must stay usable while a request is pending.
--  * Vehicle documents: the vehicle-scoped slugs required by the driver's
--    service-area rules (get_driver_document_eligibility_internal SSOT) must
--    be compliant, and the admin must confirm review of each current row.
--  * Categories: same effective rule as driver_vehicle_category_reject_reason
--    (default type on unless disabled; other types need is_enabled = true).
--    The admin confirms the full enabled set; approval writes it atomically.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Schema
-- ---------------------------------------------------------------------------

ALTER TABLE public.vehicle_change_requests
  ADD COLUMN IF NOT EXISTS previous_make text,
  ADD COLUMN IF NOT EXISTS previous_model text,
  ADD COLUMN IF NOT EXISTS previous_year integer,
  ADD COLUMN IF NOT EXISTS previous_color text,
  ADD COLUMN IF NOT EXISTS previous_license_plate text,
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS reviewed_document_ids uuid[],
  ADD COLUMN IF NOT EXISTS confirmed_vehicle_type_ids uuid[],
  ADD COLUMN IF NOT EXISTS idempotency_key uuid;

COMMENT ON COLUMN public.vehicle_change_requests.rejection_reason IS
  'Shown to the driver when an admin rejects the request. admin_notes stays internal.';

ALTER TABLE public.vehicle_change_requests
  DROP CONSTRAINT IF EXISTS vehicle_change_requests_status_check,
  ADD CONSTRAINT vehicle_change_requests_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  DROP CONSTRAINT IF EXISTS vehicle_change_requests_requested_year_check,
  ADD CONSTRAINT vehicle_change_requests_requested_year_check
    CHECK (requested_year BETWEEN 1980 AND 2100),
  DROP CONSTRAINT IF EXISTS vehicle_change_requests_rejection_reason_check,
  ADD CONSTRAINT vehicle_change_requests_rejection_reason_check
    CHECK (status <> 'rejected' OR NULLIF(btrim(rejection_reason), '') IS NOT NULL),
  DROP CONSTRAINT IF EXISTS vehicle_change_requests_decision_check,
  ADD CONSTRAINT vehicle_change_requests_decision_check
    CHECK (
      (status IN ('approved', 'rejected')) = (reviewed_at IS NOT NULL AND reviewed_by IS NOT NULL)
    ),
  DROP CONSTRAINT IF EXISTS vehicle_change_requests_cancelled_check,
  ADD CONSTRAINT vehicle_change_requests_cancelled_check
    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL));

CREATE UNIQUE INDEX IF NOT EXISTS vehicle_change_requests_one_pending_per_driver
  ON public.vehicle_change_requests (driver_id)
  WHERE status = 'pending';

CREATE UNIQUE INDEX IF NOT EXISTS vehicle_change_requests_driver_idempotency
  ON public.vehicle_change_requests (driver_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vehicle_change_requests_driver_created
  ON public.vehicle_change_requests (driver_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.vehicle_change_requests_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'VEHICLE_CHANGE_REQUEST_FINAL' USING ERRCODE = '55000';
  END IF;
  IF NEW.driver_id IS DISTINCT FROM OLD.driver_id
     OR NEW.vehicle_id IS DISTINCT FROM OLD.vehicle_id
     OR NEW.requested_make IS DISTINCT FROM OLD.requested_make
     OR NEW.requested_model IS DISTINCT FROM OLD.requested_model
     OR NEW.requested_year IS DISTINCT FROM OLD.requested_year
     OR NEW.requested_color IS DISTINCT FROM OLD.requested_color
     OR NEW.requested_license_plate IS DISTINCT FROM OLD.requested_license_plate
     OR NEW.previous_make IS DISTINCT FROM OLD.previous_make
     OR NEW.previous_model IS DISTINCT FROM OLD.previous_model
     OR NEW.previous_year IS DISTINCT FROM OLD.previous_year
     OR NEW.previous_color IS DISTINCT FROM OLD.previous_color
     OR NEW.previous_license_plate IS DISTINCT FROM OLD.previous_license_plate
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'VEHICLE_CHANGE_REQUEST_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS vehicle_change_requests_guard ON public.vehicle_change_requests;
CREATE TRIGGER vehicle_change_requests_guard
  BEFORE UPDATE ON public.vehicle_change_requests
  FOR EACH ROW EXECUTE FUNCTION public.vehicle_change_requests_guard();

-- ---------------------------------------------------------------------------
-- 2. Access: reads for admins only; every write through the RPCs below.
--    Drivers read their own history through list_driver_vehicle_change_requests
--    so admin_notes never reaches the driver.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS "Drivers can create change requests for their vehicles"
  ON public.vehicle_change_requests;
DROP POLICY IF EXISTS "Drivers can view their own change requests"
  ON public.vehicle_change_requests;

REVOKE ALL ON public.vehicle_change_requests FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER
  ON public.vehicle_change_requests FROM authenticated;
GRANT SELECT ON public.vehicle_change_requests TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. Shared helpers
-- ---------------------------------------------------------------------------

-- Document types that describe the vehicle rather than the driver. Documents are
-- driver-scoped (no vehicle_id); these are the slugs a vehicle change affects.
CREATE OR REPLACE FUNCTION public.vehicle_change_document_slugs()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT ARRAY['v5_logbook', 'mot_certificate', 'phv_license', 'private_hire_insurance']::text[];
$$;

CREATE OR REPLACE FUNCTION public.normalize_vehicle_licence_plate(p_raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT upper(regexp_replace(btrim(coalesce(p_raw, '')), '\s+', ' ', 'g'));
$$;

-- Comparison key: spacing must not let the same plate pass as a different one.
CREATE OR REPLACE FUNCTION public.vehicle_licence_plate_key(p_raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT upper(regexp_replace(coalesce(p_raw, ''), '\s+', '', 'g'));
$$;

CREATE OR REPLACE FUNCTION public.vehicle_change_request_json(r public.vehicle_change_requests)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT jsonb_build_object(
    'id', r.id,
    'status', r.status,
    'requested', jsonb_build_object(
      'make', r.requested_make,
      'model', r.requested_model,
      'year', r.requested_year,
      'colour', r.requested_color,
      'licence_plate', r.requested_license_plate
    ),
    'previous', jsonb_build_object(
      'make', r.previous_make,
      'model', r.previous_model,
      'year', r.previous_year,
      'colour', r.previous_color,
      'licence_plate', r.previous_license_plate
    ),
    'rejection_reason', r.rejection_reason,
    'created_at', r.created_at,
    'reviewed_at', r.reviewed_at,
    'cancelled_at', r.cancelled_at
  );
$$;

-- Effective category state for one driver, same rule as
-- driver_vehicle_category_reject_reason (Pet-Friendly's driver toggle is separate).
CREATE OR REPLACE FUNCTION public.driver_effective_vehicle_categories(p_driver_id uuid)
RETURNS TABLE (vehicle_type_id uuid, name text, slug text, is_default boolean,
               driver_controllable boolean, enabled boolean)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT vt.id,
         vt.name,
         vt.slug,
         COALESCE(vt.is_default, false),
         COALESCE(vt.driver_controllable, false),
         CASE
           WHEN COALESCE(vt.is_default, false)
             THEN COALESCE(dvc.is_enabled, true)
           ELSE COALESCE(dvc.is_enabled, false)
         END
  FROM public.vehicle_types vt
  LEFT JOIN public.driver_vehicle_categories dvc
    ON dvc.driver_id = p_driver_id AND dvc.vehicle_type_id = vt.id
  WHERE vt.is_active = true;
$$;

-- Applicable vehicle documents for a driver: vehicle slugs required by the
-- service-area rules, with their eligibility state and current document row.
CREATE OR REPLACE FUNCTION public.vehicle_change_applicable_documents(p_driver_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_elig jsonb;
  v_docs jsonb := '[]'::jsonb;
  v_slug text;
  v_state text;
  v_doc record;
BEGIN
  v_elig := public.get_driver_document_eligibility_internal(p_driver_id);

  IF v_elig IS NULL
     OR v_elig->>'code' IN ('DRIVER_SERVICE_AREA_NOT_ASSIGNED', 'SERVICE_AREA_DOCUMENT_RULES_NOT_CONFIGURED')
  THEN
    RETURN jsonb_build_object(
      'rules_available', false,
      'code', COALESCE(v_elig->>'code', 'DOCUMENT_ELIGIBILITY_UNAVAILABLE'),
      'documents', '[]'::jsonb
    );
  END IF;

  FOR v_slug IN
    SELECT s FROM unnest(public.vehicle_change_document_slugs()) AS s
    WHERE COALESCE(v_elig->'required_documents', '[]'::jsonb) ? s
  LOOP
    v_state := CASE
      WHEN COALESCE(v_elig->'missing_documents', '[]'::jsonb) ? v_slug THEN 'missing'
      WHEN COALESCE(v_elig->'expired_documents', '[]'::jsonb) ? v_slug THEN 'expired'
      WHEN COALESCE(v_elig->'rejected_documents', '[]'::jsonb) ? v_slug THEN 'rejected'
      WHEN COALESCE(v_elig->'pending_documents', '[]'::jsonb) ? v_slug THEN 'pending'
      ELSE 'approved'
    END;

    SELECT d.id, d.status, d.expiry_date, d.file_url, d.reviewed_at, d.created_at,
           COALESCE(dt.name, d.document_name, v_slug) AS name
      INTO v_doc
      FROM public.documents d
      LEFT JOIN public.document_types dt ON dt.slug = d.document_type
     WHERE d.driver_id = p_driver_id
       AND d.document_type = v_slug
       AND COALESCE(d.is_current, true) = true
     ORDER BY d.created_at DESC
     LIMIT 1;

    v_docs := v_docs || jsonb_build_array(jsonb_build_object(
      'slug', v_slug,
      'name', COALESCE(v_doc.name, (SELECT dt.name FROM public.document_types dt WHERE dt.slug = v_slug), v_slug),
      'state', v_state,
      'document_id', v_doc.id,
      'document_status', v_doc.status,
      'expiry_date', v_doc.expiry_date,
      'file_url', v_doc.file_url,
      'reviewed_at', v_doc.reviewed_at,
      'uploaded_at', v_doc.created_at,
      'expiring_soon', COALESCE(v_elig->'expiring_soon_documents', '[]'::jsonb) ? v_slug
    ));
  END LOOP;

  RETURN jsonb_build_object('rules_available', true, 'code', NULL, 'documents', v_docs);
END;
$$;

REVOKE ALL ON FUNCTION public.vehicle_change_applicable_documents(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.driver_effective_vehicle_categories(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.vehicle_change_request_json(public.vehicle_change_requests) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Driver RPCs
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.submit_driver_vehicle_change_request(
  p_make text,
  p_model text,
  p_year integer,
  p_color text,
  p_license_plate text,
  p_idempotency_key uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_driver_id uuid;
  v_vehicle public.vehicles%ROWTYPE;
  v_existing public.vehicle_change_requests%ROWTYPE;
  v_row public.vehicle_change_requests%ROWTYPE;
  v_make text := btrim(regexp_replace(coalesce(p_make, ''), '\s+', ' ', 'g'));
  v_model text := btrim(regexp_replace(coalesce(p_model, ''), '\s+', ' ', 'g'));
  v_color text := btrim(regexp_replace(coalesce(p_color, ''), '\s+', ' ', 'g'));
  v_plate text := public.normalize_vehicle_licence_plate(p_license_plate);
  v_max_year integer := extract(year FROM (now() AT TIME ZONE 'Europe/London'))::integer + 1;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  -- Row lock serialises concurrent submits for the same driver.
  SELECT d.id INTO v_driver_id
    FROM public.drivers d
   WHERE d.user_id = v_uid AND d.deleted_at IS NULL
   FOR UPDATE;
  IF v_driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DRIVER_NOT_FOUND');
  END IF;

  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing
      FROM public.vehicle_change_requests
     WHERE driver_id = v_driver_id AND idempotency_key = p_idempotency_key;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', true, 'idempotent', true,
        'request', public.vehicle_change_request_json(v_existing));
    END IF;
  END IF;

  SELECT * INTO v_vehicle
    FROM public.vehicles v
   WHERE v.driver_id = v_driver_id
   ORDER BY v.is_primary DESC NULLS LAST, v.created_at ASC
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_VEHICLE');
  END IF;
  IF COALESCE(v_vehicle.approval_status, '') <> 'approved' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VEHICLE_NOT_APPROVED');
  END IF;

  IF v_make = '' OR v_model = '' OR v_color = '' OR length(v_plate) < 2 OR p_year IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', CASE
      WHEN v_make = '' THEN 'make'
      WHEN v_model = '' THEN 'model'
      WHEN p_year IS NULL THEN 'year'
      WHEN v_color = '' THEN 'colour'
      ELSE 'licence_plate' END);
  END IF;
  IF length(v_make) > 40 OR length(v_model) > 40 OR length(v_color) > 30 OR length(v_plate) > 12 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', CASE
      WHEN length(v_make) > 40 THEN 'make'
      WHEN length(v_model) > 40 THEN 'model'
      WHEN length(v_color) > 30 THEN 'colour'
      ELSE 'licence_plate' END);
  END IF;
  IF p_year < 1980 OR p_year > v_max_year THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', 'year');
  END IF;
  IF v_plate !~ '^[A-Z0-9 ]+$' OR length(public.vehicle_licence_plate_key(v_plate)) < 2 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', 'licence_plate');
  END IF;

  IF lower(v_make) = lower(btrim(coalesce(v_vehicle.make, '')))
     AND lower(v_model) = lower(btrim(coalesce(v_vehicle.model, '')))
     AND p_year IS NOT DISTINCT FROM v_vehicle.year
     AND lower(v_color) = lower(btrim(coalesce(v_vehicle.color, '')))
     AND public.vehicle_licence_plate_key(v_plate) = public.vehicle_licence_plate_key(v_vehicle.license_plate)
  THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_CHANGES');
  END IF;

  SELECT * INTO v_existing
    FROM public.vehicle_change_requests
   WHERE driver_id = v_driver_id AND status = 'pending';
  IF FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PENDING_REQUEST_EXISTS',
      'request', public.vehicle_change_request_json(v_existing));
  END IF;

  -- Same ownership rule as finalize_driver_onboarding_registration.
  IF EXISTS (
    SELECT 1
      FROM public.vehicles other
      JOIN public.drivers od ON od.id = other.driver_id
     WHERE public.vehicle_licence_plate_key(other.license_plate) = public.vehicle_licence_plate_key(v_plate)
       AND other.driver_id IS DISTINCT FROM v_driver_id
       AND od.deleted_at IS NULL
  ) OR EXISTS (
    SELECT 1
      FROM public.vehicle_change_requests other_req
     WHERE other_req.status = 'pending'
       AND other_req.driver_id <> v_driver_id
       AND public.vehicle_licence_plate_key(other_req.requested_license_plate) = public.vehicle_licence_plate_key(v_plate)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VEHICLE_OWNERSHIP_CONFLICT');
  END IF;

  BEGIN
    INSERT INTO public.vehicle_change_requests (
      driver_id, vehicle_id, status,
      requested_make, requested_model, requested_year, requested_color, requested_license_plate,
      previous_make, previous_model, previous_year, previous_color, previous_license_plate,
      idempotency_key
    ) VALUES (
      v_driver_id, v_vehicle.id, 'pending',
      v_make, v_model, p_year, v_color, v_plate,
      v_vehicle.make, v_vehicle.model, v_vehicle.year, v_vehicle.color, v_vehicle.license_plate,
      p_idempotency_key
    )
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    SELECT * INTO v_existing
      FROM public.vehicle_change_requests
     WHERE driver_id = v_driver_id AND status = 'pending';
    RETURN jsonb_build_object('ok', false, 'code', 'PENDING_REQUEST_EXISTS',
      'request', CASE WHEN v_existing.id IS NULL THEN NULL
                      ELSE public.vehicle_change_request_json(v_existing) END);
  END;

  INSERT INTO public.audit_logs (event_type, user_id, driver_id, details)
  VALUES ('vehicle_change_request_submitted', v_uid, v_driver_id,
          jsonb_build_object('request_id', v_row.id, 'vehicle_id', v_vehicle.id));

  RETURN jsonb_build_object('ok', true, 'idempotent', false,
    'request', public.vehicle_change_request_json(v_row));
END;
$$;

CREATE OR REPLACE FUNCTION public.cancel_driver_vehicle_change_request(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_driver_id uuid;
  v_row public.vehicle_change_requests%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT d.id INTO v_driver_id
    FROM public.drivers d
   WHERE d.user_id = v_uid AND d.deleted_at IS NULL;
  IF v_driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DRIVER_NOT_FOUND');
  END IF;

  SELECT * INTO v_row
    FROM public.vehicle_change_requests
   WHERE id = p_request_id AND driver_id = v_driver_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  IF v_row.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_CANCELLABLE',
      'request', public.vehicle_change_request_json(v_row));
  END IF;

  UPDATE public.vehicle_change_requests
     SET status = 'cancelled', cancelled_at = now()
   WHERE id = v_row.id
  RETURNING * INTO v_row;

  INSERT INTO public.audit_logs (event_type, user_id, driver_id, details)
  VALUES ('vehicle_change_request_cancelled', v_uid, v_driver_id,
          jsonb_build_object('request_id', v_row.id));

  RETURN jsonb_build_object('ok', true, 'request', public.vehicle_change_request_json(v_row));
END;
$$;

CREATE OR REPLACE FUNCTION public.list_driver_vehicle_change_requests(p_limit integer DEFAULT 20)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_driver_id uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT d.id INTO v_driver_id
    FROM public.drivers d
   WHERE d.user_id = v_uid AND d.deleted_at IS NULL;
  IF v_driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DRIVER_NOT_FOUND', 'requests', '[]'::jsonb);
  END IF;

  RETURN jsonb_build_object('ok', true, 'requests', COALESCE((
    SELECT jsonb_agg(s.j ORDER BY s.created_at DESC)
      FROM (
        SELECT public.vehicle_change_request_json(r) AS j, r.created_at
          FROM public.vehicle_change_requests r
         WHERE r.driver_id = v_driver_id
         ORDER BY r.created_at DESC
         LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50)
      ) s
  ), '[]'::jsonb));
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. Admin RPCs
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_get_vehicle_change_review(p_request_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.vehicle_change_requests%ROWTYPE;
  v_vehicle public.vehicles%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'admin'::app_role) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM public.vehicle_change_requests WHERE id = p_request_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = v_row.vehicle_id;

  RETURN jsonb_build_object(
    'ok', true,
    'request', public.vehicle_change_request_json(v_row)
      || jsonb_build_object('admin_notes', v_row.admin_notes,
                            'driver_id', v_row.driver_id,
                            'vehicle_id', v_row.vehicle_id,
                            'reviewed_document_ids', to_jsonb(v_row.reviewed_document_ids),
                            'confirmed_vehicle_type_ids', to_jsonb(v_row.confirmed_vehicle_type_ids)),
    'current_vehicle', CASE WHEN v_vehicle.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_vehicle.id,
      'make', v_vehicle.make,
      'model', v_vehicle.model,
      'year', v_vehicle.year,
      'colour', v_vehicle.color,
      'licence_plate', v_vehicle.license_plate,
      'approval_status', v_vehicle.approval_status,
      'capacity', v_vehicle.capacity,
      'belongs_to_driver', v_vehicle.driver_id = v_row.driver_id) END,
    'vehicle_documents', public.vehicle_change_applicable_documents(v_row.driver_id),
    'categories', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'vehicle_type_id', c.vehicle_type_id,
               'name', c.name,
               'slug', c.slug,
               'is_default', c.is_default,
               'driver_controllable', c.driver_controllable,
               'enabled', c.enabled)
             ORDER BY c.is_default DESC, c.name)
        FROM public.driver_effective_vehicle_categories(v_row.driver_id) c
    ), '[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_decide_vehicle_change_request(
  p_request_id uuid,
  p_decision text,
  p_rejection_reason text DEFAULT NULL,
  p_admin_notes text DEFAULT NULL,
  p_reviewed_document_ids uuid[] DEFAULT NULL,
  p_enabled_vehicle_type_ids uuid[] DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_row public.vehicle_change_requests%ROWTYPE;
  v_vehicle public.vehicles%ROWTYPE;
  v_driver public.drivers%ROWTYPE;
  v_docs jsonb;
  v_doc jsonb;
  v_not_compliant jsonb := '[]'::jsonb;
  v_expected_ids uuid[];
  v_reviewed uuid[];
  v_enabled uuid[];
  v_reason text := NULLIF(btrim(coalesce(p_rejection_reason, '')), '');
  v_notes text := NULLIF(btrim(coalesce(p_admin_notes, '')), '');
  v_cat record;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'admin'::app_role) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  IF p_decision IS NULL OR p_decision NOT IN ('approve', 'reject') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_DECISION');
  END IF;

  SELECT * INTO v_row FROM public.vehicle_change_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  IF v_row.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ALREADY_DECIDED', 'status', v_row.status);
  END IF;

  SELECT * INTO v_driver FROM public.drivers WHERE id = v_row.driver_id FOR UPDATE;
  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = v_row.vehicle_id FOR UPDATE;

  IF p_decision = 'reject' THEN
    IF v_reason IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'REJECTION_REASON_REQUIRED');
    END IF;

    UPDATE public.vehicle_change_requests
       SET status = 'rejected', rejection_reason = v_reason, admin_notes = v_notes,
           reviewed_at = now(), reviewed_by = v_uid
     WHERE id = v_row.id
    RETURNING * INTO v_row;

    UPDATE public.drivers SET vehicle_edit_request_status = 'rejected' WHERE id = v_row.driver_id;

    INSERT INTO public.driver_inbox_messages (driver_id, type, title, body, metadata)
    VALUES (v_row.driver_id, 'vehicle_change', 'Vehicle change request rejected',
            'Your vehicle change request was not approved. Your current vehicle stays active. Reason: ' || v_reason,
            jsonb_build_object('request_id', v_row.id, 'status', 'rejected'));

    INSERT INTO public.audit_logs (event_type, user_id, driver_id, details)
    VALUES ('vehicle_change_request_rejected', v_uid, v_row.driver_id,
            jsonb_build_object('request_id', v_row.id, 'reason', v_reason));

    RETURN jsonb_build_object('ok', true, 'request', public.vehicle_change_request_json(v_row));
  END IF;

  -- Approve -------------------------------------------------------------------
  IF v_driver.id IS NULL OR v_driver.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DRIVER_NOT_ACTIVE');
  END IF;
  IF v_vehicle.id IS NULL OR v_vehicle.driver_id IS DISTINCT FROM v_row.driver_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VEHICLE_OWNERSHIP_MISMATCH');
  END IF;
  -- The vehicle must still be the one the driver asked to change.
  IF v_vehicle.make IS DISTINCT FROM v_row.previous_make
     OR v_vehicle.model IS DISTINCT FROM v_row.previous_model
     OR v_vehicle.year IS DISTINCT FROM v_row.previous_year
     OR v_vehicle.color IS DISTINCT FROM v_row.previous_color
     OR v_vehicle.license_plate IS DISTINCT FROM v_row.previous_license_plate
  THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VEHICLE_CHANGED_SINCE_REQUEST');
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.vehicles other
      JOIN public.drivers od ON od.id = other.driver_id
     WHERE public.vehicle_licence_plate_key(other.license_plate)
           = public.vehicle_licence_plate_key(v_row.requested_license_plate)
       AND other.driver_id IS DISTINCT FROM v_row.driver_id
       AND od.deleted_at IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VEHICLE_OWNERSHIP_CONFLICT');
  END IF;

  -- Vehicle documents: compliant per the service-area rules, and each current
  -- row explicitly reviewed by the admin.
  v_docs := public.vehicle_change_applicable_documents(v_row.driver_id);
  IF NOT COALESCE((v_docs->>'rules_available')::boolean, false) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DOCUMENT_RULES_UNAVAILABLE',
      'detail', v_docs->>'code');
  END IF;
  FOR v_doc IN SELECT * FROM jsonb_array_elements(v_docs->'documents') LOOP
    IF v_doc->>'state' <> 'approved' OR v_doc->>'document_id' IS NULL THEN
      v_not_compliant := v_not_compliant || jsonb_build_array(
        jsonb_build_object('slug', v_doc->>'slug', 'state', v_doc->>'state'));
    END IF;
  END LOOP;
  IF jsonb_array_length(v_not_compliant) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VEHICLE_DOCUMENTS_NOT_COMPLIANT',
      'documents', v_not_compliant);
  END IF;

  SELECT COALESCE(array_agg((d->>'document_id')::uuid ORDER BY d->>'document_id'), ARRAY[]::uuid[])
    INTO v_expected_ids
    FROM jsonb_array_elements(v_docs->'documents') d;
  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), ARRAY[]::uuid[])
    INTO v_reviewed
    FROM unnest(COALESCE(p_reviewed_document_ids, ARRAY[]::uuid[])) x;
  IF p_reviewed_document_ids IS NULL OR v_reviewed IS DISTINCT FROM v_expected_ids THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VEHICLE_DOCUMENTS_NOT_REVIEWED',
      'expected_document_ids', to_jsonb(v_expected_ids));
  END IF;

  -- Category recheck: the admin confirms the full enabled set.
  IF p_enabled_vehicle_type_ids IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CATEGORY_RECHECK_REQUIRED');
  END IF;
  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), ARRAY[]::uuid[])
    INTO v_enabled
    FROM unnest(p_enabled_vehicle_type_ids) x;
  IF EXISTS (
    SELECT 1 FROM unnest(v_enabled) x
     WHERE NOT EXISTS (SELECT 1 FROM public.vehicle_types vt WHERE vt.id = x AND vt.is_active = true)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'UNKNOWN_VEHICLE_CATEGORY');
  END IF;
  IF cardinality(v_enabled) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_ELIGIBLE_CATEGORY');
  END IF;

  FOR v_cat IN SELECT * FROM public.driver_effective_vehicle_categories(v_row.driver_id) LOOP
    IF v_cat.enabled IS DISTINCT FROM (v_cat.vehicle_type_id = ANY (v_enabled)) THEN
      INSERT INTO public.driver_vehicle_categories (driver_id, vehicle_type_id, is_enabled)
      VALUES (v_row.driver_id, v_cat.vehicle_type_id, v_cat.vehicle_type_id = ANY (v_enabled))
      ON CONFLICT (driver_id, vehicle_type_id)
      DO UPDATE SET is_enabled = EXCLUDED.is_enabled, updated_at = now();
    END IF;
  END LOOP;

  -- Apply. The vehicle keeps approval_status = 'approved' (admin path).
  UPDATE public.vehicles
     SET make = v_row.requested_make,
         model = v_row.requested_model,
         year = v_row.requested_year,
         color = v_row.requested_color,
         license_plate = v_row.requested_license_plate
   WHERE id = v_vehicle.id;

  UPDATE public.vehicle_change_requests
     SET status = 'approved', admin_notes = v_notes,
         reviewed_at = now(), reviewed_by = v_uid,
         reviewed_document_ids = v_expected_ids,
         confirmed_vehicle_type_ids = v_enabled
   WHERE id = v_row.id
  RETURNING * INTO v_row;

  UPDATE public.drivers SET vehicle_edit_request_status = 'approved' WHERE id = v_row.driver_id;

  INSERT INTO public.driver_inbox_messages (driver_id, type, title, body, metadata)
  VALUES (v_row.driver_id, 'vehicle_change', 'Vehicle change approved',
          'Your vehicle details have been updated to ' || v_row.requested_make || ' '
            || v_row.requested_model || ' (' || v_row.requested_license_plate || ').',
          jsonb_build_object('request_id', v_row.id, 'status', 'approved'));

  INSERT INTO public.audit_logs (event_type, user_id, driver_id, details)
  VALUES ('vehicle_change_request_approved', v_uid, v_row.driver_id,
          jsonb_build_object('request_id', v_row.id,
                             'vehicle_id', v_vehicle.id,
                             'reviewed_document_ids', to_jsonb(v_expected_ids),
                             'enabled_vehicle_type_ids', to_jsonb(v_enabled)));

  RETURN jsonb_build_object('ok', true, 'request', public.vehicle_change_request_json(v_row));
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.submit_driver_vehicle_change_request(text, text, integer, text, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cancel_driver_vehicle_change_request(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.list_driver_vehicle_change_requests(integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_get_vehicle_change_review(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_decide_vehicle_change_request(uuid, text, text, text, uuid[], uuid[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.vehicle_change_requests_guard() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.submit_driver_vehicle_change_request(text, text, integer, text, text, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cancel_driver_vehicle_change_request(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_driver_vehicle_change_requests(integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_vehicle_change_review(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_decide_vehicle_change_request(uuid, text, text, text, uuid[], uuid[]) TO authenticated, service_role;

COMMIT;
