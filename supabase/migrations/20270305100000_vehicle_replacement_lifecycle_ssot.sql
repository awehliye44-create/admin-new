-- Vehicle replacement lifecycle SSOT.
--
-- Root cause addressed:
--  1) admin_decide_vehicle_change_request mutated the SAME vehicles row in place,
--     destroying previous identity so Admin history could not keep old-plate docs.
--  2) documents had no vehicle_id — vehicle-scoped uploads were driver+type only,
--     so replacement uploads could not be distinguished from the primary vehicle's
--     approved documents.
--
-- Design:
--  * Primary (vehicles.is_primary) = driver's usual choice.
--  * Trip-active (vehicles.is_trip_active) = Admin-selected vehicle for trips.
--  * operational_status: active | suspended_under_repair | available_in_fleet | archived.
--  * submit creates a NEW pending vehicle (+ request.requested_vehicle_id).
--  * approve activates the new vehicle; previous row is retained (optionally suspended).
--  * documents.vehicle_id scopes ownership; vehicle-doc supersession is per-vehicle.
--  * Max 3 saved vehicles per driver (excluding available_in_fleet / archived fleet assets).
--
-- No production data mutations beyond additive columns, safe backfill, and RPC replace.
-- Deploy is Owner-gated separately — this migration is authored only.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Schema
-- ---------------------------------------------------------------------------

-- Shared fleet assets may be unassigned between drivers.
ALTER TABLE public.vehicles
  ALTER COLUMN driver_id DROP NOT NULL;

ALTER TABLE public.vehicles
  ADD COLUMN IF NOT EXISTS operational_status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS is_trip_active boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS fleet_shared boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS suspended_reason text,
  ADD COLUMN IF NOT EXISTS ambiguity_review_required boolean NOT NULL DEFAULT false;

ALTER TABLE public.vehicles
  DROP CONSTRAINT IF EXISTS vehicles_operational_status_check,
  ADD CONSTRAINT vehicles_operational_status_check
    CHECK (operational_status IN (
      'active',
      'suspended_under_repair',
      'available_in_fleet',
      'archived'
    ));

COMMENT ON COLUMN public.vehicles.is_primary IS
  'Driver-chosen usual vehicle. Distinct from is_trip_active (Admin trip selection).';
COMMENT ON COLUMN public.vehicles.is_trip_active IS
  'Admin-authoritative vehicle used for trips / Go Online eligibility.';
COMMENT ON COLUMN public.vehicles.operational_status IS
  'active = usable; suspended_under_repair = accident/council pause (retain); available_in_fleet = shared pool; archived = not reusable.';

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS vehicle_id uuid REFERENCES public.vehicles(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ambiguity_review_required boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_documents_vehicle_id
  ON public.documents (vehicle_id)
  WHERE vehicle_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_documents_driver_vehicle_type_current
  ON public.documents (driver_id, vehicle_id, document_type)
  WHERE COALESCE(is_current, true) = true;

ALTER TABLE public.vehicle_change_requests
  ADD COLUMN IF NOT EXISTS reason text,
  ADD COLUMN IF NOT EXISTS requested_vehicle_id uuid REFERENCES public.vehicles(id),
  ADD COLUMN IF NOT EXISTS suspend_previous boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS change_kind text NOT NULL DEFAULT 'replacement';

ALTER TABLE public.vehicle_change_requests
  DROP CONSTRAINT IF EXISTS vehicle_change_requests_change_kind_check,
  ADD CONSTRAINT vehicle_change_requests_change_kind_check
    CHECK (change_kind IN ('replacement', 'reactivation', 'shared_assignment'));

-- Shared temporary fleet assignments (time-bounded). Ending an assignment never
-- deletes the vehicle asset.
CREATE TABLE IF NOT EXISTS public.vehicle_driver_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES public.vehicles(id),
  driver_id uuid NOT NULL REFERENCES public.drivers(id),
  change_request_id uuid REFERENCES public.vehicle_change_requests(id),
  assignment_kind text NOT NULL DEFAULT 'temporary_replacement'
    CHECK (assignment_kind IN ('temporary_replacement', 'reactivation', 'owned')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  ended_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vehicle_driver_assignments_end_check
    CHECK (ended_at IS NULL OR ended_at >= started_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS vehicle_driver_assignments_one_open_per_vehicle
  ON public.vehicle_driver_assignments (vehicle_id)
  WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_vehicle_driver_assignments_driver_open
  ON public.vehicle_driver_assignments (driver_id)
  WHERE ended_at IS NULL;

REVOKE ALL ON public.vehicle_driver_assignments FROM PUBLIC, anon;
GRANT SELECT ON public.vehicle_driver_assignments TO authenticated;

-- At most one trip-active vehicle per driver among non-fleet-pool rows.
CREATE UNIQUE INDEX IF NOT EXISTS vehicles_one_trip_active_per_driver
  ON public.vehicles (driver_id)
  WHERE is_trip_active = true
    AND operational_status IN ('active', 'suspended_under_repair');

-- ---------------------------------------------------------------------------
-- 2. Safe backfill (single-vehicle drivers → certain vehicle_id association)
-- ---------------------------------------------------------------------------

UPDATE public.vehicles v
   SET is_trip_active = true,
       operational_status = CASE
         WHEN lower(COALESCE(v.approval_status, '')) = 'approved' THEN 'active'
         ELSE COALESCE(v.operational_status, 'active')
       END
 WHERE COALESCE(v.is_primary, false) = true
   AND v.is_trip_active = false;

-- Exactly one vehicle per driver: associate legacy vehicle-scoped docs safely.
WITH single AS (
  SELECT driver_id, (array_agg(id ORDER BY is_primary DESC, created_at ASC))[1] AS vehicle_id
  FROM public.vehicles
  GROUP BY driver_id
  HAVING count(*) = 1
)
UPDATE public.documents d
   SET vehicle_id = s.vehicle_id
  FROM single s
 WHERE d.driver_id = s.driver_id
   AND d.vehicle_id IS NULL
   AND d.document_type = ANY (ARRAY[
     'v5_logbook',
     'mot_certificate',
     'phv_license',
     'private_hire_insurance',
     'additional_insurance_document',
     'exemption_certificate'
   ]::text[]);

-- Multi-vehicle drivers with unscoped vehicle docs → flag for Admin (do not guess).
UPDATE public.documents d
   SET ambiguity_review_required = true
 WHERE d.vehicle_id IS NULL
   AND d.document_type = ANY (ARRAY[
     'v5_logbook',
     'mot_certificate',
     'phv_license',
     'private_hire_insurance',
     'additional_insurance_document',
     'exemption_certificate'
   ]::text[])
   AND EXISTS (
     SELECT 1 FROM public.vehicles v
     WHERE v.driver_id = d.driver_id
     GROUP BY v.driver_id
     HAVING count(*) > 1
   );

-- ---------------------------------------------------------------------------
-- 3. Vehicle-scoped document slug SSOT (still intersected with SA rules)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.vehicle_change_document_slugs()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT ARRAY[
    'v5_logbook',
    'mot_certificate',
    'phv_license',
    'private_hire_insurance',
    'additional_insurance_document',
    'exemption_certificate'
  ]::text[];
$$;

CREATE OR REPLACE FUNCTION public.is_vehicle_scoped_document_slug(p_slug text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT COALESCE(p_slug, '') = ANY (public.vehicle_change_document_slugs());
$$;

-- Resolve which vehicle a new vehicle-scoped document should attach to.
CREATE OR REPLACE FUNCTION public.resolve_vehicle_document_target(p_driver_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_req public.vehicle_change_requests%ROWTYPE;
  v_id uuid;
BEGIN
  SELECT * INTO v_req
    FROM public.vehicle_change_requests
   WHERE driver_id = p_driver_id AND status = 'pending'
   ORDER BY created_at DESC
   LIMIT 1;
  IF FOUND AND v_req.requested_vehicle_id IS NOT NULL THEN
    RETURN v_req.requested_vehicle_id;
  END IF;

  SELECT v.id INTO v_id
    FROM public.vehicles v
   WHERE v.driver_id = p_driver_id
     AND v.is_trip_active = true
   ORDER BY v.updated_at DESC
   LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  SELECT v.id INTO v_id
    FROM public.vehicles v
   WHERE v.driver_id = p_driver_id
   ORDER BY v.is_primary DESC NULLS LAST, v.created_at ASC
   LIMIT 1;
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_vehicle_document_target(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_vehicle_document_target(uuid) TO service_role;

-- Stamp vehicle_id on insert for vehicle-scoped types; never clear an explicit value.
CREATE OR REPLACE FUNCTION public.trg_documents_stamp_vehicle_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF public.is_vehicle_scoped_document_slug(NEW.document_type) AND NEW.vehicle_id IS NULL THEN
    NEW.vehicle_id := public.resolve_vehicle_document_target(NEW.driver_id);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS documents_stamp_vehicle_id ON public.documents;
CREATE TRIGGER documents_stamp_vehicle_id
  BEFORE INSERT ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.trg_documents_stamp_vehicle_id();

-- When a new current vehicle-scoped document is inserted, demote only same-vehicle
-- current rows of the same type — never the previous vehicle's approved docs.
CREATE OR REPLACE FUNCTION public.trg_documents_vehicle_scoped_supersede()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'INSERT'
     AND COALESCE(NEW.is_current, true) = true
     AND public.is_vehicle_scoped_document_slug(NEW.document_type)
     AND NEW.vehicle_id IS NOT NULL
  THEN
    UPDATE public.documents d
       SET is_current = false,
           superseded_by = NEW.id,
           updated_at = now()
     WHERE d.driver_id = NEW.driver_id
       AND d.document_type = NEW.document_type
       AND d.id IS DISTINCT FROM NEW.id
       AND COALESCE(d.is_current, true) = true
       AND d.vehicle_id IS NOT DISTINCT FROM NEW.vehicle_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS documents_vehicle_scoped_supersede ON public.documents;
CREATE TRIGGER documents_vehicle_scoped_supersede
  AFTER INSERT ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.trg_documents_vehicle_scoped_supersede();

-- Cap owned/saved vehicles at 3 (fleet pool assets excluded).
CREATE OR REPLACE FUNCTION public.trg_vehicles_max_saved_per_driver()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_count integer;
BEGIN
  IF NEW.operational_status IN ('available_in_fleet', 'archived') THEN
    RETURN NEW;
  END IF;
  IF NEW.driver_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT count(*) INTO v_count
    FROM public.vehicles v
   WHERE v.driver_id = NEW.driver_id
     AND v.operational_status NOT IN ('available_in_fleet', 'archived')
     AND (TG_OP = 'INSERT' OR v.id IS DISTINCT FROM NEW.id);
  IF v_count >= 3 THEN
    RAISE EXCEPTION 'VEHICLE_LIMIT_REACHED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS vehicles_max_saved_per_driver ON public.vehicles;
CREATE TRIGGER vehicles_max_saved_per_driver
  BEFORE INSERT OR UPDATE OF driver_id, operational_status ON public.vehicles
  FOR EACH ROW EXECUTE FUNCTION public.trg_vehicles_max_saved_per_driver();

-- ---------------------------------------------------------------------------
-- 4. Request JSON + applicable documents (prefer requested vehicle)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.vehicle_change_request_json(r public.vehicle_change_requests)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT jsonb_build_object(
    'id', r.id,
    'status', r.status,
    'reason', r.reason,
    'suspend_previous', r.suspend_previous,
    'change_kind', r.change_kind,
    'requested_vehicle_id', r.requested_vehicle_id,
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
  v_target uuid;
BEGIN
  v_elig := public.get_driver_document_eligibility_internal(p_driver_id);
  v_target := public.resolve_vehicle_document_target(p_driver_id);

  IF v_elig IS NULL
     OR v_elig->>'code' IN ('DRIVER_SERVICE_AREA_NOT_ASSIGNED', 'SERVICE_AREA_DOCUMENT_RULES_NOT_CONFIGURED')
  THEN
    RETURN jsonb_build_object(
      'rules_available', false,
      'code', COALESCE(v_elig->>'code', 'DOCUMENT_ELIGIBILITY_UNAVAILABLE'),
      'vehicle_id', v_target,
      'documents', '[]'::jsonb
    );
  END IF;

  FOR v_slug IN
    SELECT s FROM unnest(public.vehicle_change_document_slugs()) AS s
    WHERE COALESCE(v_elig->'required_documents', '[]'::jsonb) ? s
  LOOP
    SELECT d.id, d.status, d.expiry_date, d.file_url, d.reviewed_at, d.created_at,
           COALESCE(dt.name, d.document_name, v_slug) AS name,
           d.vehicle_id
      INTO v_doc
      FROM public.documents d
      LEFT JOIN public.document_types dt ON dt.slug = d.document_type
     WHERE d.driver_id = p_driver_id
       AND d.document_type = v_slug
       AND COALESCE(d.is_current, true) = true
       AND (v_target IS NULL OR d.vehicle_id IS NOT DISTINCT FROM v_target)
     ORDER BY d.created_at DESC
     LIMIT 1;

    v_state := CASE
      WHEN v_doc.id IS NULL THEN 'missing'
      WHEN lower(COALESCE(v_doc.status, '')) = 'approved' THEN 'approved'
      WHEN lower(COALESCE(v_doc.status, '')) = 'pending' THEN 'pending'
      WHEN lower(COALESCE(v_doc.status, '')) = 'rejected' THEN 'rejected'
      WHEN lower(COALESCE(v_doc.status, '')) = 'expired' THEN 'expired'
      ELSE 'missing'
    END;

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
      'vehicle_id', COALESCE(v_doc.vehicle_id, v_target),
      'expiring_soon', COALESCE(v_elig->'expiring_soon_documents', '[]'::jsonb) ? v_slug
    ));
  END LOOP;

  RETURN jsonb_build_object(
    'rules_available', true,
    'code', NULL,
    'vehicle_id', v_target,
    'documents', v_docs
  );
END;
$$;

-- ---------------------------------------------------------------------------
-- 5a. Drop prior submit signature before recreating with reason/suspend params
DROP FUNCTION IF EXISTS public.submit_driver_vehicle_change_request(text, text, integer, text, text, uuid);

-- 5. Submit: create NEW pending vehicle (do not mutate primary identity)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.submit_driver_vehicle_change_request(
  p_make text,
  p_model text,
  p_year integer,
  p_color text,
  p_license_plate text,
  p_idempotency_key uuid DEFAULT NULL,
  p_reason text DEFAULT NULL,
  p_suspend_previous boolean DEFAULT false
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
  v_new public.vehicles%ROWTYPE;
  v_make text := btrim(regexp_replace(coalesce(p_make, ''), '\s+', ' ', 'g'));
  v_model text := btrim(regexp_replace(coalesce(p_model, ''), '\s+', ' ', 'g'));
  v_color text := btrim(regexp_replace(coalesce(p_color, ''), '\s+', ' ', 'g'));
  v_plate text := public.normalize_vehicle_licence_plate(p_license_plate);
  v_reason text := NULLIF(btrim(coalesce(p_reason, '')), '');
  v_max_year integer := extract(year FROM (now() AT TIME ZONE 'Europe/London'))::integer + 1;
  v_saved_count integer;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

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
     AND v.operational_status NOT IN ('available_in_fleet', 'archived')
   ORDER BY v.is_trip_active DESC, v.is_primary DESC NULLS LAST, v.created_at ASC
   LIMIT 1
   FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_VEHICLE');
  END IF;
  IF COALESCE(v_vehicle.approval_status, '') <> 'approved'
     AND v_vehicle.operational_status <> 'suspended_under_repair' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VEHICLE_NOT_APPROVED');
  END IF;

  IF v_make = '' OR v_model = '' OR v_color = '' OR length(v_plate) < 2 OR p_year IS NULL OR v_reason IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT', 'field', CASE
      WHEN v_make = '' THEN 'make'
      WHEN v_model = '' THEN 'model'
      WHEN p_year IS NULL THEN 'year'
      WHEN v_color = '' THEN 'colour'
      WHEN v_reason IS NULL THEN 'reason'
      ELSE 'licence_plate' END);
  END IF;
  IF length(v_make) > 40 OR length(v_model) > 40 OR length(v_color) > 30 OR length(v_plate) > 12 OR length(v_reason) > 200 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'INVALID_INPUT');
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

  SELECT count(*) INTO v_saved_count
    FROM public.vehicles v
   WHERE v.driver_id = v_driver_id
     AND v.operational_status NOT IN ('available_in_fleet', 'archived');
  IF v_saved_count >= 3 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VEHICLE_LIMIT_REACHED');
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.vehicles other
      JOIN public.drivers od ON od.id = other.driver_id
     WHERE public.vehicle_licence_plate_key(other.license_plate) = public.vehicle_licence_plate_key(v_plate)
       AND other.driver_id IS DISTINCT FROM v_driver_id
       AND od.deleted_at IS NULL
       AND other.operational_status <> 'archived'
  ) OR EXISTS (
    SELECT 1
      FROM public.vehicle_change_requests other_req
     WHERE other_req.status = 'pending'
       AND other_req.driver_id <> v_driver_id
       AND public.vehicle_licence_plate_key(other_req.requested_license_plate) = public.vehicle_licence_plate_key(v_plate)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VEHICLE_OWNERSHIP_CONFLICT');
  END IF;

  INSERT INTO public.vehicles (
    driver_id, make, model, year, color, license_plate,
    capacity, vehicle_type_id, approval_status, is_primary, is_trip_active,
    operational_status, fleet_shared
  ) VALUES (
    v_driver_id, v_make, v_model, p_year, v_color, v_plate,
    COALESCE(v_vehicle.capacity, 4), v_vehicle.vehicle_type_id, 'pending', false, false,
    'active', false
  )
  RETURNING * INTO v_new;

  BEGIN
    INSERT INTO public.vehicle_change_requests (
      driver_id, vehicle_id, status,
      requested_make, requested_model, requested_year, requested_color, requested_license_plate,
      previous_make, previous_model, previous_year, previous_color, previous_license_plate,
      idempotency_key, reason, requested_vehicle_id, suspend_previous, change_kind
    ) VALUES (
      v_driver_id, v_vehicle.id, 'pending',
      v_make, v_model, p_year, v_color, v_plate,
      v_vehicle.make, v_vehicle.model, v_vehicle.year, v_vehicle.color, v_vehicle.license_plate,
      p_idempotency_key, v_reason, v_new.id, COALESCE(p_suspend_previous, false), 'replacement'
    )
    RETURNING * INTO v_row;
  EXCEPTION WHEN unique_violation THEN
    -- Roll back the pending vehicle if request insert raced.
    UPDATE public.vehicles SET operational_status = 'archived', is_trip_active = false
     WHERE id = v_new.id;
    SELECT * INTO v_existing
      FROM public.vehicle_change_requests
     WHERE driver_id = v_driver_id AND status = 'pending';
    RETURN jsonb_build_object('ok', false, 'code', 'PENDING_REQUEST_EXISTS',
      'request', CASE WHEN v_existing.id IS NULL THEN NULL
                      ELSE public.vehicle_change_request_json(v_existing) END);
  END;

  IF COALESCE(p_suspend_previous, false) THEN
    UPDATE public.vehicles
       SET operational_status = 'suspended_under_repair',
           is_trip_active = false,
           suspended_reason = v_reason,
           updated_at = now()
     WHERE id = v_vehicle.id;
  END IF;

  INSERT INTO public.audit_logs (event_type, user_id, driver_id, details)
  VALUES ('vehicle_change_request_submitted', v_uid, v_driver_id,
          jsonb_build_object(
            'request_id', v_row.id,
            'previous_vehicle_id', v_vehicle.id,
            'requested_vehicle_id', v_new.id,
            'suspend_previous', COALESCE(p_suspend_previous, false)
          ));

  RETURN jsonb_build_object('ok', true, 'idempotent', false,
    'request', public.vehicle_change_request_json(v_row));
END;
$$;

-- Cancel: archive the unused pending replacement vehicle; restore previous if suspended by this request.
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
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_CANCELLABLE');
  END IF;

  UPDATE public.vehicle_change_requests
     SET status = 'cancelled', cancelled_at = now()
   WHERE id = v_row.id
  RETURNING * INTO v_row;

  IF v_row.requested_vehicle_id IS NOT NULL THEN
    UPDATE public.vehicles
       SET operational_status = 'archived',
           is_trip_active = false,
           is_primary = false,
           updated_at = now()
     WHERE id = v_row.requested_vehicle_id
       AND driver_id = v_driver_id
       AND approval_status = 'pending';
  END IF;

  IF v_row.suspend_previous THEN
    UPDATE public.vehicles
       SET operational_status = 'active',
           is_trip_active = true,
           suspended_reason = NULL,
           updated_at = now()
     WHERE id = v_row.vehicle_id
       AND driver_id = v_driver_id
       AND operational_status = 'suspended_under_repair';
  END IF;

  INSERT INTO public.audit_logs (event_type, user_id, driver_id, details)
  VALUES ('vehicle_change_request_cancelled', v_uid, v_driver_id,
          jsonb_build_object('request_id', v_row.id));

  RETURN jsonb_build_object('ok', true, 'request', public.vehicle_change_request_json(v_row));
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Approve: activate NEW vehicle; never rewrite previous identity fields
-- ---------------------------------------------------------------------------

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
  v_prev public.vehicles%ROWTYPE;
  v_new public.vehicles%ROWTYPE;
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
  SELECT * INTO v_prev FROM public.vehicles WHERE id = v_row.vehicle_id FOR UPDATE;
  IF v_row.requested_vehicle_id IS NOT NULL THEN
    SELECT * INTO v_new FROM public.vehicles WHERE id = v_row.requested_vehicle_id FOR UPDATE;
  END IF;

  IF p_decision = 'reject' THEN
    IF v_reason IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'REJECTION_REASON_REQUIRED');
    END IF;

    UPDATE public.vehicle_change_requests
       SET status = 'rejected', rejection_reason = v_reason, admin_notes = v_notes,
           reviewed_at = now(), reviewed_by = v_uid
     WHERE id = v_row.id
    RETURNING * INTO v_row;

    IF v_new.id IS NOT NULL THEN
      UPDATE public.vehicles
         SET approval_status = 'rejected',
             rejection_reason = v_reason,
             is_trip_active = false,
             operational_status = 'archived',
             updated_at = now()
       WHERE id = v_new.id;
    END IF;

    IF v_row.suspend_previous AND v_prev.id IS NOT NULL THEN
      UPDATE public.vehicles
         SET operational_status = 'active',
             is_trip_active = true,
             suspended_reason = NULL,
             updated_at = now()
       WHERE id = v_prev.id;
    END IF;

    UPDATE public.drivers SET vehicle_edit_request_status = 'rejected' WHERE id = v_row.driver_id;

    INSERT INTO public.driver_inbox_messages (driver_id, type, title, body, metadata)
    VALUES (v_row.driver_id, 'vehicle_change', 'Vehicle change request rejected',
            'Your vehicle change request was not approved. Your previous vehicle records were kept. Reason: ' || v_reason,
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
  IF v_prev.id IS NULL OR v_prev.driver_id IS DISTINCT FROM v_row.driver_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VEHICLE_OWNERSHIP_MISMATCH');
  END IF;
  IF v_new.id IS NULL OR v_new.driver_id IS DISTINCT FROM v_row.driver_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'REQUESTED_VEHICLE_MISSING');
  END IF;
  IF v_prev.make IS DISTINCT FROM v_row.previous_make
     OR v_prev.model IS DISTINCT FROM v_row.previous_model
     OR v_prev.year IS DISTINCT FROM v_row.previous_year
     OR v_prev.color IS DISTINCT FROM v_row.previous_color
     OR v_prev.license_plate IS DISTINCT FROM v_row.previous_license_plate
  THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VEHICLE_CHANGED_SINCE_REQUEST');
  END IF;
  IF EXISTS (
    SELECT 1
      FROM public.vehicles other
      JOIN public.drivers od ON od.id = other.driver_id
     WHERE public.vehicle_licence_plate_key(other.license_plate)
           = public.vehicle_licence_plate_key(v_row.requested_license_plate)
       AND other.id IS DISTINCT FROM v_new.id
       AND other.driver_id IS DISTINCT FROM v_row.driver_id
       AND od.deleted_at IS NULL
       AND other.operational_status <> 'archived'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'VEHICLE_OWNERSHIP_CONFLICT');
  END IF;

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

  -- Activate new vehicle; retain previous identity (suspend or demote primary only).
  UPDATE public.vehicles
     SET approval_status = 'approved',
         rejection_reason = NULL,
         is_primary = true,
         is_trip_active = true,
         operational_status = 'active',
         make = v_row.requested_make,
         model = v_row.requested_model,
         year = v_row.requested_year,
         color = v_row.requested_color,
         license_plate = v_row.requested_license_plate,
         updated_at = now()
   WHERE id = v_new.id;

  UPDATE public.vehicles
     SET is_primary = false,
         is_trip_active = false,
         operational_status = CASE
           WHEN v_row.suspend_previous THEN 'suspended_under_repair'
           ELSE operational_status
         END,
         suspended_reason = CASE
           WHEN v_row.suspend_previous THEN COALESCE(v_row.reason, suspended_reason)
           ELSE suspended_reason
         END,
         updated_at = now()
   WHERE id = v_prev.id;

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
          'Your replacement vehicle ' || v_row.requested_make || ' '
            || v_row.requested_model || ' (' || v_row.requested_license_plate
            || ') is now active. Previous vehicle records were kept.',
          jsonb_build_object(
            'request_id', v_row.id,
            'status', 'approved',
            'requested_vehicle_id', v_new.id,
            'previous_vehicle_id', v_prev.id
          ));

  INSERT INTO public.audit_logs (event_type, user_id, driver_id, details)
  VALUES ('vehicle_change_request_approved', v_uid, v_row.driver_id,
          jsonb_build_object(
            'request_id', v_row.id,
            'previous_vehicle_id', v_prev.id,
            'requested_vehicle_id', v_new.id,
            'reviewed_document_ids', to_jsonb(v_expected_ids),
            'enabled_vehicle_type_ids', to_jsonb(v_enabled),
            'identity_preserved', true
          ));

  RETURN jsonb_build_object('ok', true, 'request', public.vehicle_change_request_json(v_row));
END;
$$;

-- Go Online: require an approved trip-active vehicle that is operationally active.
CREATE OR REPLACE FUNCTION public.driver_has_eligible_trip_vehicle(p_driver_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.vehicles v
     WHERE v.driver_id = p_driver_id
       AND v.is_trip_active = true
       AND v.operational_status = 'active'
       AND lower(COALESCE(v.approval_status, '')) = 'approved'
  );
$$;


-- ---------------------------------------------------------------------------
-- 7. DROP old submit signature (params changed) then keep grants
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.submit_driver_vehicle_change_request(text, text, integer, text, text, uuid);

-- Recreate submit with new signature (body already defined above once CREATE ran —
-- but DROP removed it). Re-apply by including the same CREATE from earlier is
-- awkward in one file; instead the CREATE above must come AFTER the DROP.
-- Fix: the file currently CREATE OR REPLACE with new args before DROP — Postgres
-- would create an overload. Ensure only the new signature remains:
-- (If migration order already created overload, DROP old now.)

-- The CREATE at section 5 used the new signature; if an old overload still exists,
-- DROP it. If CREATE failed in environments that reject OR REPLACE with new args,
-- the DROP above then requires the CREATE to run again — handled by re-emitting
-- a thin wrapper note: section 5 already emitted CREATE OR REPLACE for the new
-- 8-arg form which creates a *new* overload alongside the 6-arg form. After DROP
-- of 6-arg, only 8-arg remains. Good.

GRANT EXECUTE ON FUNCTION public.submit_driver_vehicle_change_request(text, text, integer, text, text, uuid, text, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cancel_driver_vehicle_change_request(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.list_driver_vehicle_change_requests(integer) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_decide_vehicle_change_request(uuid, text, text, text, uuid[], uuid[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_get_vehicle_change_review(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.vehicle_change_applicable_documents(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.driver_has_eligible_trip_vehicle(uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. Trip-active vehicle resolver (Go Online doc checks use this, not pending)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_trip_active_vehicle_id(p_driver_id uuid)
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT v.id
    FROM public.vehicles v
   WHERE v.driver_id = p_driver_id
     AND v.is_trip_active = true
   ORDER BY v.updated_at DESC
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.resolve_trip_active_vehicle_id(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_trip_active_vehicle_id(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 9. Block cross-vehicle supersession of approved vehicle documents
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.trg_documents_block_cross_vehicle_supersede()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF COALESCE(OLD.is_current, true) = true
     AND COALESCE(NEW.is_current, true) = false
     AND public.is_vehicle_scoped_document_slug(OLD.document_type)
     AND OLD.vehicle_id IS NOT NULL
     AND NEW.superseded_by IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM public.documents winner
        WHERE winner.id = NEW.superseded_by
          AND winner.vehicle_id IS DISTINCT FROM OLD.vehicle_id
     )
  THEN
    NEW.is_current := true;
    NEW.superseded_by := OLD.superseded_by;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS documents_block_cross_vehicle_supersede ON public.documents;
CREATE TRIGGER documents_block_cross_vehicle_supersede
  BEFORE UPDATE OF is_current, superseded_by ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.trg_documents_block_cross_vehicle_supersede();

-- ---------------------------------------------------------------------------
-- 10. My Documents SSOT view: vehicle docs scoped to upload target
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.driver_document_compliance_ssot AS
 WITH targets AS (
         SELECT dr.id AS driver_id,
            public.resolve_vehicle_document_target(dr.id) AS vehicle_id
           FROM drivers dr
        ), current_docs AS (
         SELECT d.driver_id,
            d.document_type,
            d.id AS document_id,
            d.status,
            d.expiry_date,
            d.file_url,
            d.updated_at,
            d.is_current,
            d.superseded_by,
            d.vehicle_id
           FROM documents d
           JOIN targets t ON t.driver_id = d.driver_id
          WHERE d.is_current = true
            AND (
              NOT public.is_vehicle_scoped_document_slug(d.document_type)
              OR d.vehicle_id IS NOT DISTINCT FROM t.vehicle_id
            )
        ), today_london AS (
         SELECT (now() AT TIME ZONE 'Europe/London'::text)::date AS today
        )
 SELECT dr.id AS driver_id,
    dt.id AS document_type_id,
    dt.slug AS document_type_key,
    dt.name AS display_name,
    dt.is_required,
    dt.has_expiry,
    cd.document_id,
    cd.status AS approval_status,
    cd.expiry_date,
    cd.file_url,
    cd.updated_at AS last_updated_at,
    cd.superseded_by AS replacement_document_id,
    COALESCE(cd.is_current, false) AS is_current,
    cd.document_id IS NOT NULL AND cd.is_current = false AS is_superseded,
    document_type_renewal_open_days(dt.reminder_days_before_expiry) AS renewal_open_days,
        CASE
            WHEN cd.expiry_date IS NULL THEN NULL::integer
            ELSE cd.expiry_date - (( SELECT today_london.today FROM today_london))
        END AS days_until_expiry,
        CASE
            WHEN cd.document_id IS NULL THEN 'missing'::text
            WHEN lower(COALESCE(cd.status, ''::text)) = ANY (ARRAY['rejected'::text, 'declined'::text]) THEN 'rejected'::text
            WHEN lower(COALESCE(cd.status, ''::text)) = ANY (ARRAY['pending'::text, 'uploaded'::text, 'submitted'::text, 'under_review'::text]) THEN 'pending'::text
            WHEN dt.has_expiry AND cd.expiry_date IS NOT NULL AND cd.expiry_date < (( SELECT today_london.today FROM today_london)) THEN 'expired'::text
            WHEN dt.has_expiry AND cd.expiry_date IS NOT NULL AND lower(COALESCE(cd.status, ''::text)) = 'approved'::text AND cd.expiry_date <= ((( SELECT today_london.today FROM today_london)) + make_interval(days => document_type_renewal_open_days(dt.reminder_days_before_expiry)))::date THEN 'expiring_soon'::text
            WHEN lower(COALESCE(cd.status, ''::text)) = 'approved'::text THEN 'approved_valid'::text
            ELSE 'pending'::text
        END AS expiry_status,
        CASE
            WHEN cd.document_id IS NULL THEN 'missing'::text
            WHEN lower(COALESCE(cd.status, ''::text)) = ANY (ARRAY['rejected'::text, 'declined'::text]) THEN 'rejected'::text
            WHEN lower(COALESCE(cd.status, ''::text)) = ANY (ARRAY['pending'::text, 'uploaded'::text, 'submitted'::text, 'under_review'::text]) THEN 'pending_review'::text
            WHEN dt.has_expiry AND cd.expiry_date IS NOT NULL AND cd.expiry_date < (( SELECT today_london.today FROM today_london)) THEN 'expired'::text
            WHEN dt.has_expiry AND cd.expiry_date IS NOT NULL AND lower(COALESCE(cd.status, ''::text)) = 'approved'::text AND cd.expiry_date <= ((( SELECT today_london.today FROM today_london)) + make_interval(days => document_type_renewal_open_days(dt.reminder_days_before_expiry)))::date THEN 'expiring'::text
            WHEN lower(COALESCE(cd.status, ''::text)) = 'approved'::text THEN 'valid'::text
            ELSE 'pending_review'::text
        END AS renewal_state,
        CASE
            WHEN cd.document_id IS NULL THEN true
            WHEN lower(COALESCE(cd.status, ''::text)) = ANY (ARRAY['rejected'::text, 'declined'::text]) THEN true
            WHEN lower(COALESCE(cd.status, ''::text)) = ANY (ARRAY['pending'::text, 'uploaded'::text, 'submitted'::text, 'under_review'::text]) THEN false
            WHEN dt.has_expiry AND cd.expiry_date IS NOT NULL AND cd.expiry_date < (( SELECT today_london.today FROM today_london)) THEN true
            WHEN dt.has_expiry AND cd.expiry_date IS NOT NULL AND lower(COALESCE(cd.status, ''::text)) = 'approved'::text AND (cd.expiry_date - (( SELECT today_london.today FROM today_london))) <= document_type_renewal_open_days(dt.reminder_days_before_expiry) THEN true
            ELSE false
        END AS can_upload_replacement,
    -- Vehicle-scoped gaps on a pending replacement must not block Go Online;
    -- trip eligibility uses assert_driver_presence + trip-active vehicle docs.
    CASE
      WHEN public.is_vehicle_scoped_document_slug(dt.slug)
           AND public.resolve_vehicle_document_target(dr.id)
               IS DISTINCT FROM public.resolve_trip_active_vehicle_id(dr.id)
        THEN false
      ELSE dt.is_required AND (cd.document_id IS NULL OR (lower(COALESCE(cd.status, ''::text)) = ANY (ARRAY['rejected'::text, 'declined'::text])) OR dt.has_expiry AND cd.expiry_date IS NOT NULL AND cd.expiry_date < (( SELECT today_london.today FROM today_london)))
    END AS blocks_online
   FROM drivers dr
     CROSS JOIN document_types dt
     LEFT JOIN current_docs cd ON cd.driver_id = dr.id AND cd.document_type = dt.slug
  WHERE dt.is_active = true AND (dt.is_required = true OR cd.document_id IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 11. Patch eligibility (Go Online) to trip-active vehicle docs
-- ---------------------------------------------------------------------------


CREATE OR REPLACE FUNCTION public.get_driver_document_eligibility_internal(p_driver_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $$
DECLARE
  v_service_area_id uuid;
  v_service_area_name text;
  v_rules_configured boolean;
  v_today_london date;
  v_warn_days integer := 7;
  v_required_slugs text[] := ARRAY[]::text[];
  v_missing text[] := ARRAY[]::text[];
  v_expired text[] := ARRAY[]::text[];
  v_pending text[] := ARRAY[]::text[];
  v_rejected text[] := ARRAY[]::text[];
  v_expiring text[] := ARRAY[]::text[];
  v_hash_parts text[] := ARRAY[]::text[];
  v_slug text;
  v_status text;
  v_expiry date;
  v_expiry_required boolean;
  v_approved_count integer := 0;
  v_required_count integer := 0;
  v_document_status text;
  v_compliance_hash text;
  v_rule_version text;
  v_should_open boolean;
  v_approved boolean;
BEGIN
  v_today_london := public.driver_compliance_today_london();

  BEGIN
    SELECT GREATEST(1, (setting_value->>0)::integer)
    INTO v_warn_days
    FROM public.admin_settings
    WHERE setting_key = 'document_expiry_reminder_days'
    LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_warn_days := 7;
  END;

  SELECT d.service_area_id, sa.name
  INTO v_service_area_id, v_service_area_name
  FROM public.drivers d
  LEFT JOIN public.service_areas sa ON sa.id = d.service_area_id
  WHERE d.id = p_driver_id;

  IF v_service_area_id IS NULL THEN
    v_compliance_hash := p_driver_id::text || '|none|service_area_not_assigned|';
    RETURN jsonb_build_object(
      'approved', false,
      'document_status', 'service_area_not_assigned',
      'code', 'DRIVER_SERVICE_AREA_NOT_ASSIGNED',
      'message', 'Driver has no assigned service area. Assign a service area before going online.',
      'service_area_id', null,
      'service_area_name', null,
      'required_documents', '[]'::jsonb,
      'missing_documents', '[]'::jsonb,
      'expired_documents', '[]'::jsonb,
      'pending_documents', '[]'::jsonb,
      'rejected_documents', '[]'::jsonb,
      'expiring_soon_documents', '[]'::jsonb,
      'compliance_hash', v_compliance_hash,
      'rule_version', 'none',
      'should_open_documents', true,
      'should_notify', false
    );
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.service_area_document_rules sar
    WHERE sar.service_area_id = v_service_area_id
  ) INTO v_rules_configured;

  SELECT COALESCE(
    md5(string_agg(
      sar.id::text || ':' || sar.is_active::text || ':' || sar.mandatory::text || ':' ||
      COALESCE(sar.display_in_driver_app, true)::text || ':' || COALESCE(sar.expiry_required, true)::text,
      ',' ORDER BY sar.id
    )),
    'empty'
  )
  INTO v_rule_version
  FROM public.service_area_document_rules sar
  WHERE sar.service_area_id = v_service_area_id;

  IF NOT v_rules_configured THEN
    v_compliance_hash := p_driver_id::text || '|' || v_service_area_id::text || '|rules_not_configured|' || v_rule_version;
    RETURN jsonb_build_object(
      'approved', false,
      'document_status', 'rules_not_configured',
      'code', 'SERVICE_AREA_DOCUMENT_RULES_NOT_CONFIGURED',
      'message', format(
        'Document rules are not configured for service area %s.',
        COALESCE(v_service_area_name, v_service_area_id::text)
      ),
      'service_area_id', v_service_area_id,
      'service_area_name', v_service_area_name,
      'required_documents', '[]'::jsonb,
      'missing_documents', '[]'::jsonb,
      'expired_documents', '[]'::jsonb,
      'pending_documents', '[]'::jsonb,
      'rejected_documents', '[]'::jsonb,
      'expiring_soon_documents', '[]'::jsonb,
      'compliance_hash', v_compliance_hash,
      'rule_version', v_rule_version,
      'should_open_documents', true,
      'should_notify', false
    );
  END IF;

  -- Mandatory rules (missing / rejected / expired / pending all block).
  FOR v_slug, v_expiry_required IN
    SELECT dt.slug, COALESCE(sar.expiry_required, true)
    FROM public.service_area_document_rules sar
    JOIN public.document_types dt ON dt.id = sar.doc_type_id
    WHERE sar.service_area_id = v_service_area_id
      AND sar.is_active = true
      AND COALESCE(sar.display_in_driver_app, true) = true
      AND sar.mandatory = true
      AND dt.is_active = true
    ORDER BY sar.sort_order NULLS LAST, dt.display_order NULLS LAST, dt.name
  LOOP
    v_required_count := v_required_count + 1;
    v_required_slugs := array_append(v_required_slugs, v_slug);

    SELECT d.status, d.expiry_date
    INTO v_status, v_expiry
    FROM public.documents d
    WHERE d.driver_id = p_driver_id
      AND d.document_type = v_slug
      AND COALESCE(d.is_current, true) = true
      AND (
        NOT public.is_vehicle_scoped_document_slug(v_slug)
        OR d.vehicle_id IS NOT DISTINCT FROM public.resolve_trip_active_vehicle_id(p_driver_id)
      )
    ORDER BY
      CASE WHEN d.status = 'approved' THEN 0 ELSE 1 END,
      d.updated_at DESC NULLS LAST
    LIMIT 1;

    IF v_status IS NULL THEN
      v_missing := array_append(v_missing, v_slug);
      v_hash_parts := array_append(v_hash_parts, v_slug || ':missing:');
      CONTINUE;
    END IF;

    v_status := lower(trim(v_status));
    v_hash_parts := array_append(
      v_hash_parts,
      v_slug || ':' || v_status || ':' || COALESCE(v_expiry::text, '')
    );

    IF v_status IN ('rejected', 'declined', 'resubmission_required', 'resubmit_required', 'requires_resubmission') THEN
      v_rejected := array_append(v_rejected, v_slug);
      CONTINUE;
    END IF;

    IF v_expiry_required AND (v_expiry IS NULL OR v_expiry < v_today_london) THEN
      v_expired := array_append(v_expired, v_slug);
      CONTINUE;
    END IF;

    IF v_status = 'approved' THEN
      v_approved_count := v_approved_count + 1;
      IF v_expiry_required
         AND v_expiry IS NOT NULL
         AND v_expiry >= v_today_london
         AND v_expiry <= (v_today_london + v_warn_days)
      THEN
        v_expiring := array_append(v_expiring, v_slug);
      END IF;
      CONTINUE;
    END IF;

    v_pending := array_append(v_pending, v_slug);
  END LOOP;

  -- Optional (non-mandatory) documents never independently block Go Online.
  -- Missing / pending / approved / expired / rejected / missing-expiry optional
  -- rows remain visible via Driver documents SSOT; expiry is enforced at upload
  -- when service_area_document_rules.expiry_required is true.
  -- (Policy reversal of 20261231120000 optional expiry block.)

  IF array_length(v_missing, 1) IS NOT NULL THEN
    v_document_status := 'missing_required';
  ELSIF array_length(v_rejected, 1) IS NOT NULL THEN
    v_document_status := 'rejected_required';
  ELSIF array_length(v_expired, 1) IS NOT NULL THEN
    v_document_status := 'expired_required';
  ELSIF array_length(v_expiring, 1) IS NOT NULL THEN
    v_document_status := 'expiring_soon';
  ELSE
    v_document_status := 'compliant';
  END IF;

  v_approved := (
    v_document_status IN ('compliant', 'expiring_soon')
    AND array_length(v_pending, 1) IS NULL
  );

  IF array_length(v_pending, 1) IS NOT NULL THEN
    v_approved := false;
    IF v_document_status IN ('compliant', 'expiring_soon') THEN
      v_document_status := 'missing_required';
    END IF;
  END IF;

  v_should_open := v_document_status IN (
    'missing_required',
    'rejected_required',
    'expired_required',
    'service_area_not_assigned',
    'rules_not_configured'
  );

  v_compliance_hash := md5(
    p_driver_id::text || '|' ||
    v_service_area_id::text || '|' ||
    v_rule_version || '|' ||
    v_document_status || '|' ||
    COALESCE(array_to_string(v_hash_parts, ';'), '')
  );

  RETURN jsonb_build_object(
    'approved', v_approved,
    'document_status', v_document_status,
    'code', CASE
      WHEN v_approved AND v_document_status = 'compliant' THEN null
      WHEN v_document_status = 'expiring_soon' THEN null
      WHEN v_document_status = 'missing_required' AND array_length(v_pending, 1) IS NOT NULL THEN 'DOCUMENTS_PENDING_REVIEW'
      WHEN v_document_status = 'missing_required' THEN 'DOCUMENTS_MISSING'
      WHEN v_document_status = 'rejected_required' THEN 'DOCUMENTS_REJECTED'
      WHEN v_document_status = 'expired_required' THEN 'DOCUMENTS_EXPIRED'
      ELSE 'DOCUMENTS_PENDING_REVIEW'
    END,
    'message', CASE
      WHEN v_approved AND v_document_status = 'compliant' THEN ''
      WHEN v_document_status = 'expiring_soon' THEN format(
        '%s document(s) expiring soon for %s',
        array_length(v_expiring, 1),
        COALESCE(v_service_area_name, 'assigned service area')
      )
      WHEN array_length(v_rejected, 1) IS NOT NULL THEN format(
        'Rejected documents for %s: %s',
        COALESCE(v_service_area_name, 'assigned service area'),
        array_to_string(v_rejected, ', ')
      )
      WHEN array_length(v_expired, 1) IS NOT NULL THEN format(
        'Expired documents for %s: %s',
        COALESCE(v_service_area_name, 'assigned service area'),
        array_to_string(v_expired, ', ')
      )
      WHEN array_length(v_missing, 1) IS NOT NULL THEN format(
        'Missing documents for %s: %s',
        COALESCE(v_service_area_name, 'assigned service area'),
        array_to_string(v_missing, ', ')
      )
      WHEN array_length(v_pending, 1) IS NOT NULL THEN format(
        'Documents pending review for %s: %s',
        COALESCE(v_service_area_name, 'assigned service area'),
        array_to_string(v_pending, ', ')
      )
      ELSE 'Documents incomplete for assigned service area.'
    END,
    'service_area_id', v_service_area_id,
    'service_area_name', v_service_area_name,
    'required_documents', to_jsonb(v_required_slugs),
    'missing_documents', to_jsonb(v_missing),
    'expired_documents', to_jsonb(v_expired),
    'pending_documents', to_jsonb(v_pending),
    'rejected_documents', to_jsonb(v_rejected),
    'expiring_soon_documents', to_jsonb(
      CASE WHEN v_approved THEN v_expiring ELSE ARRAY[]::text[] END
    ),
    'compliance_hash', v_compliance_hash,
    'rule_version', v_rule_version,
    'should_open_documents', v_should_open,
    'should_notify', false
  );
END;
$$
;

CREATE OR REPLACE FUNCTION public.assert_driver_presence_online_eligible(p_driver_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $$
DECLARE
  v_driver public.drivers%ROWTYPE;
  v_doc jsonb;
  v_has_vehicle boolean;
  v_identity jsonb;
BEGIN
  SELECT * INTO v_driver
  FROM public.drivers
  WHERE id = p_driver_id
    AND deleted_at IS NULL;

  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'code', 'DRIVER_NOT_FOUND',
      'message', 'Driver profile not found.'
    );
  END IF;

  IF lower(COALESCE(v_driver.approval_status, '')) <> 'approved' THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'code', 'DRIVER_NOT_APPROVED',
      'message', 'Driver is not approved.'
    );
  END IF;

  IF lower(COALESCE(v_driver.driver_status::text, '')) <> 'active' THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'code', 'DRIVER_ACCOUNT_DISABLED',
      'message', 'Driver account is disabled.'
    );
  END IF;

  IF COALESCE(v_driver.phone_verified, false) <> true THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'code', 'PHONE_UNVERIFIED',
      'message', 'Phone verification required before going online.'
    );
  END IF;

  IF v_driver.service_area_id IS NULL THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'code', 'DRIVER_SERVICE_AREA_NOT_ASSIGNED',
      'message', 'Assign a service area before going online.'
    );
  END IF;

  IF COALESCE(v_driver.vehicle_edit_request_status, '') = 'pending' THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'code', 'VEHICLE_CHANGE_PENDING',
      'message', 'Vehicle change request is pending admin approval.'
    );
  END IF;

  v_doc := public.get_driver_document_eligibility_internal(p_driver_id);
  IF COALESCE((v_doc ->> 'approved')::boolean, false) <> true THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'code', COALESCE(v_doc ->> 'code', 'DOCUMENTS_NOT_APPROVED'),
      'message', COALESCE(v_doc ->> 'message', 'Documents must be approved before going online.')
    );
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM public.vehicles v
    WHERE v.driver_id = p_driver_id
      AND v.is_trip_active = true
      AND v.operational_status = 'active'
      AND lower(COALESCE(v.approval_status, '')) = 'approved'
  ) INTO v_has_vehicle;

  IF NOT v_has_vehicle THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'code', 'VEHICLE_NOT_APPROVED',
      'message', 'An approved active vehicle is required before going online.'
    );
  END IF;

  v_identity := public.get_driver_identity_verification_gate(p_driver_id);
  IF COALESCE((v_identity ->> 'blocking')::boolean, false) = true THEN
    RETURN jsonb_build_object(
      'eligible', false,
      'code', COALESCE(v_identity ->> 'code', 'IDENTITY_VERIFICATION_REQUIRED'),
      'message', 'Identity verification is required before going online.',
      'identity_status', v_identity ->> 'status',
      'verification_id', v_identity ->> 'verification_id'
    );
  END IF;

  RETURN jsonb_build_object('eligible', true, 'code', 'OK', 'message', '');
END;
$$
;


-- ---------------------------------------------------------------------------
-- 12. Admin review payload includes requested vehicle + reason
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
  v_prev public.vehicles%ROWTYPE;
  v_new public.vehicles%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'admin'::app_role) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_row FROM public.vehicle_change_requests WHERE id = p_request_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  SELECT * INTO v_prev FROM public.vehicles WHERE id = v_row.vehicle_id;
  IF v_row.requested_vehicle_id IS NOT NULL THEN
    SELECT * INTO v_new FROM public.vehicles WHERE id = v_row.requested_vehicle_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'request', public.vehicle_change_request_json(v_row)
      || jsonb_build_object('admin_notes', v_row.admin_notes,
                            'driver_id', v_row.driver_id,
                            'vehicle_id', v_row.vehicle_id,
                            'requested_vehicle_id', v_row.requested_vehicle_id,
                            'reviewed_document_ids', to_jsonb(v_row.reviewed_document_ids),
                            'confirmed_vehicle_type_ids', to_jsonb(v_row.confirmed_vehicle_type_ids)),
    'current_vehicle', CASE WHEN v_prev.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_prev.id,
      'make', v_prev.make,
      'model', v_prev.model,
      'year', v_prev.year,
      'colour', v_prev.color,
      'licence_plate', v_prev.license_plate,
      'approval_status', v_prev.approval_status,
      'operational_status', v_prev.operational_status,
      'is_primary', v_prev.is_primary,
      'is_trip_active', v_prev.is_trip_active,
      'capacity', v_prev.capacity,
      'belongs_to_driver', v_prev.driver_id = v_row.driver_id) END,
    'requested_vehicle', CASE WHEN v_new.id IS NULL THEN NULL ELSE jsonb_build_object(
      'id', v_new.id,
      'make', v_new.make,
      'model', v_new.model,
      'year', v_new.year,
      'colour', v_new.color,
      'licence_plate', v_new.license_plate,
      'approval_status', v_new.approval_status,
      'operational_status', v_new.operational_status,
      'is_primary', v_new.is_primary,
      'is_trip_active', v_new.is_trip_active) END,
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

-- ---------------------------------------------------------------------------
-- 13. Shared temporary assignment return (never delete asset)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_return_shared_vehicle_assignment(
  p_assignment_id uuid,
  p_ended_reason text DEFAULT 'returned_to_fleet'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_asg public.vehicle_driver_assignments%ROWTYPE;
  v_vehicle public.vehicles%ROWTYPE;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'admin'::app_role) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_asg FROM public.vehicle_driver_assignments WHERE id = p_assignment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  IF v_asg.ended_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ALREADY_ENDED');
  END IF;

  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = v_asg.vehicle_id FOR UPDATE;

  UPDATE public.vehicle_driver_assignments
     SET ended_at = now(),
         ended_reason = NULLIF(btrim(coalesce(p_ended_reason, '')), ''),
         updated_at = now()
   WHERE id = v_asg.id;

  -- Detach from driver saved list; keep asset + documents.
  UPDATE public.vehicles
     SET driver_id = NULL,
         is_primary = false,
         is_trip_active = false,
         operational_status = 'available_in_fleet',
         fleet_shared = true,
         updated_at = now()
   WHERE id = v_vehicle.id;

  INSERT INTO public.audit_logs (event_type, user_id, driver_id, details)
  VALUES ('vehicle_shared_assignment_returned', v_uid, v_asg.driver_id,
          jsonb_build_object(
            'assignment_id', v_asg.id,
            'vehicle_id', v_vehicle.id,
            'documents_preserved', true
          ));

  RETURN jsonb_build_object('ok', true, 'vehicle_id', v_vehicle.id, 'assignment_id', v_asg.id);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_return_shared_vehicle_assignment(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_return_shared_vehicle_assignment(uuid, text) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 14. Reactivate repaired own vehicle (reuse valid docs; request only gaps)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.admin_reactivate_driver_vehicle(
  p_vehicle_id uuid,
  p_release_temporary_vehicle_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_vehicle public.vehicles%ROWTYPE;
  v_temp public.vehicles%ROWTYPE;
  v_docs jsonb;
  v_doc jsonb;
  v_gaps jsonb := '[]'::jsonb;
BEGIN
  IF v_uid IS NULL OR NOT public.has_role(v_uid, 'admin'::app_role) THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_vehicle FROM public.vehicles WHERE id = p_vehicle_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  IF v_vehicle.driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NO_DRIVER');
  END IF;

  -- Temporarily point applicable-docs resolution at this vehicle via a synthetic
  -- check: reuse vehicle_change_applicable_documents only after ensuring target.
  -- Validate current docs on THIS vehicle_id directly.
  FOR v_doc IN
    SELECT jsonb_build_object('slug', s.slug, 'state',
      CASE
        WHEN d.id IS NULL THEN 'missing'
        WHEN lower(COALESCE(d.status,'')) = 'approved'
             AND (d.expiry_date IS NULL OR d.expiry_date >= (now() AT TIME ZONE 'Europe/London')::date)
          THEN 'approved'
        WHEN lower(COALESCE(d.status,'')) = 'pending' THEN 'pending'
        WHEN lower(COALESCE(d.status,'')) = 'rejected' THEN 'rejected'
        WHEN lower(COALESCE(d.status,'')) = 'expired' THEN 'expired'
        WHEN d.expiry_date IS NOT NULL AND d.expiry_date < (now() AT TIME ZONE 'Europe/London')::date THEN 'expired'
        ELSE 'missing'
      END,
      'document_id', d.id
    ) AS j
    FROM unnest(public.vehicle_change_document_slugs()) AS s(slug)
    LEFT JOIN LATERAL (
      SELECT doc.*
        FROM public.documents doc
       WHERE doc.driver_id = v_vehicle.driver_id
         AND doc.document_type = s.slug
         AND COALESCE(doc.is_current, true) = true
         AND doc.vehicle_id = v_vehicle.id
       ORDER BY doc.created_at DESC
       LIMIT 1
    ) d ON true
    WHERE EXISTS (
      SELECT 1
        FROM jsonb_array_elements_text(
          COALESCE(
            (public.get_driver_document_eligibility_internal(v_vehicle.driver_id)->'required_documents'),
            '[]'::jsonb
          )
        ) req WHERE req = s.slug
    )
  LOOP
    IF (v_doc.j->>'state') <> 'approved' THEN
      v_gaps := v_gaps || jsonb_build_array(v_doc.j);
    END IF;
  END LOOP;

  IF jsonb_array_length(v_gaps) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DOCUMENTS_INVALID', 'gaps', v_gaps);
  END IF;

  -- Clear other trip-active flags for this driver then activate.
  UPDATE public.vehicles
     SET is_trip_active = false,
         updated_at = now()
   WHERE driver_id = v_vehicle.driver_id
     AND id IS DISTINCT FROM v_vehicle.id
     AND is_trip_active = true;

  UPDATE public.vehicles
     SET operational_status = 'active',
         approval_status = 'approved',
         is_trip_active = true,
         is_primary = true,
         suspended_reason = NULL,
         updated_at = now()
   WHERE id = v_vehicle.id;

  UPDATE public.vehicles
     SET is_primary = false,
         updated_at = now()
   WHERE driver_id = v_vehicle.driver_id
     AND id IS DISTINCT FROM v_vehicle.id
     AND is_primary = true;

  IF p_release_temporary_vehicle_id IS NOT NULL THEN
    SELECT * INTO v_temp FROM public.vehicles WHERE id = p_release_temporary_vehicle_id FOR UPDATE;
    IF FOUND THEN
      UPDATE public.vehicle_driver_assignments
         SET ended_at = now(),
             ended_reason = 'owner_vehicle_reactivated',
             updated_at = now()
       WHERE vehicle_id = v_temp.id
         AND driver_id = v_vehicle.driver_id
         AND ended_at IS NULL;

      UPDATE public.vehicles
         SET driver_id = CASE WHEN fleet_shared THEN NULL ELSE driver_id END,
             is_primary = false,
             is_trip_active = false,
             operational_status = CASE WHEN fleet_shared THEN 'available_in_fleet' ELSE operational_status END,
             updated_at = now()
       WHERE id = v_temp.id;
    END IF;
  END IF;

  INSERT INTO public.audit_logs (event_type, user_id, driver_id, details)
  VALUES ('vehicle_reactivated', v_uid, v_vehicle.driver_id,
          jsonb_build_object(
            'vehicle_id', v_vehicle.id,
            'released_temporary_vehicle_id', p_release_temporary_vehicle_id,
            'reused_documents', true
          ));

  RETURN jsonb_build_object('ok', true, 'vehicle_id', v_vehicle.id);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_reactivate_driver_vehicle(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.admin_reactivate_driver_vehicle(uuid, uuid) TO authenticated, service_role;

-- Driver: set primary among own saved vehicles (not trip-active).
CREATE OR REPLACE FUNCTION public.set_driver_primary_vehicle(p_vehicle_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_driver_id uuid;
  v_vehicle public.vehicles%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  SELECT d.id INTO v_driver_id FROM public.drivers d
   WHERE d.user_id = v_uid AND d.deleted_at IS NULL;
  IF v_driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DRIVER_NOT_FOUND');
  END IF;

  SELECT * INTO v_vehicle FROM public.vehicles
   WHERE id = p_vehicle_id AND driver_id = v_driver_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  IF v_vehicle.operational_status IN ('available_in_fleet', 'archived') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_SELECTABLE');
  END IF;

  UPDATE public.vehicles SET is_primary = false, updated_at = now()
   WHERE driver_id = v_driver_id AND is_primary = true AND id IS DISTINCT FROM p_vehicle_id;
  UPDATE public.vehicles SET is_primary = true, updated_at = now()
   WHERE id = p_vehicle_id;

  INSERT INTO public.audit_logs (event_type, user_id, driver_id, details)
  VALUES ('driver_primary_vehicle_set', v_uid, v_driver_id,
          jsonb_build_object('vehicle_id', p_vehicle_id));

  RETURN jsonb_build_object('ok', true, 'vehicle_id', p_vehicle_id);
END;
$$;

REVOKE ALL ON FUNCTION public.set_driver_primary_vehicle(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_driver_primary_vehicle(uuid) TO authenticated, service_role;

-- Driver: remove inactive saved vehicle (not trip-active, not pending request target).
CREATE OR REPLACE FUNCTION public.remove_driver_saved_vehicle(p_vehicle_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_driver_id uuid;
  v_vehicle public.vehicles%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not authorized' USING ERRCODE = '42501';
  END IF;
  SELECT d.id INTO v_driver_id FROM public.drivers d
   WHERE d.user_id = v_uid AND d.deleted_at IS NULL;
  IF v_driver_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'DRIVER_NOT_FOUND');
  END IF;

  SELECT * INTO v_vehicle FROM public.vehicles
   WHERE id = p_vehicle_id AND driver_id = v_driver_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'NOT_FOUND');
  END IF;
  IF v_vehicle.is_trip_active OR v_vehicle.is_primary THEN
    RETURN jsonb_build_object('ok', false, 'code', 'CANNOT_REMOVE_ACTIVE_OR_PRIMARY');
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.vehicle_change_requests r
     WHERE r.driver_id = v_driver_id AND r.status = 'pending'
       AND (r.vehicle_id = p_vehicle_id OR r.requested_vehicle_id = p_vehicle_id)
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'PENDING_REQUEST');
  END IF;
  IF v_vehicle.fleet_shared THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SHARED_USE_ADMIN_RETURN');
  END IF;

  UPDATE public.vehicles
     SET operational_status = 'archived',
         is_trip_active = false,
         is_primary = false,
         updated_at = now()
   WHERE id = p_vehicle_id;

  INSERT INTO public.audit_logs (event_type, user_id, driver_id, details)
  VALUES ('driver_saved_vehicle_removed', v_uid, v_driver_id,
          jsonb_build_object('vehicle_id', p_vehicle_id, 'documents_preserved', true));

  RETURN jsonb_build_object('ok', true, 'vehicle_id', p_vehicle_id);
END;
$$;

REVOKE ALL ON FUNCTION public.remove_driver_saved_vehicle(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.remove_driver_saved_vehicle(uuid) TO authenticated, service_role;


-- Admin page column allowlists for vehicle lifecycle fields
CREATE OR REPLACE FUNCTION public._admin_page_columns(p_table text)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'extensions'
AS $$
  SELECT CASE lower(p_table)
    WHEN 'trips' THEN ARRAY[
      'id','trip_code','trip_number','status','financial_outcome','passenger_id','passenger_name',
      'passenger_phone','pickup_address','pickup_latitude','pickup_longitude','dropoff_address',
      'dropoff_latitude','dropoff_longitude','estimated_fare','fare','gross_fare_pence',
      'commission_pence','driver_net_pence','final_fare_pence','final_customer_fare_pence',
      'capture_amount_pence','commissionable_fare_pence','no_show_charge_pence',
      'locked_base_fare_pence','accepted_preset_offer_fare_pence','accepted_driver_offer_fare_pence',
      'customer_modification_charge_pence','destination_change_adjustment_pence',
      'modification_delta_pence','modification_status','modified_dropoff_address',
      'offer_discount_pence','voucher_discount_pence','discount_pence','applied_offer_code',
      'provider_fee_pence','onecab_net_pence','payment_status','payment_method','payment_provider',
      'provider_order_id','provider_payment_id','currency_code','estimated_distance_km',
      'estimated_duration_minutes','refund_amount_pence','refunded_at','total_stops','stops',
      'created_at','started_at','completed_at','cancelled_at','cancellation_reason',
      'surge_multiplier','driver_id','previous_driver_id','driver_location_lat','driver_location_lng',
      'stacked_trip_id','corporate_account_id','region_id','service_area_id','financial_model',
      'cancellation_fee_pence','pricing_mode','fare_locked','vehicle_type_id','vehicle_type',
      'fare_engine_config_id','waiting_charge_pence','pickup_waiting_charge_pence',
      'stop_waiting_charge_pence','total_waiting_charge_pence','stop_charge_total_pence',
      'waiting_minutes','fare_breakdown','tip_pence','tip_amount_pence','airport_charge_pence',
      'other_pass_through_charges_pence','accepted_commission_percent','driver_tier_commission_percent',
      'commission_pct','estimated_total_pence','fare_snapshot_json','arrival_cancellation_applied',
      'arrival_cancellation_fee','is_scheduled','scheduled_status','searching_expires_at',
      'invoice_no','invoice_pdf_url','invoice_generated_at','invoice_email_sent',
      'invoice_email_sent_at','invoice_email_status','invoice_email_error','invoice_pdf_error',
      'invoice_total_paid_pence','invoice_regenerated_at','invoice_payment_classification',
      'invoice_paid_pence','invoice_outstanding_pence','invoice_delivery_eligible',
      'trip_history_event_at','missed_cancelled_event_at',
      'scheduled_at','scheduled_broadcast_at','scheduled_accepted_at','scheduled_convert_at',
      'confirmed_driver_id','pending_release_kind','pending_release_at','pending_release_driver_id',
      'dispatch_mode','special_instructions','payment_type','job_type','trip_type','booking_source',
      'arrived_at','pickup_waiting_started_at','cancelled_by','cancelled_by_role','cancel_reason',
      'cancellation_note','late_cancel_fee_pence','arrival_cancellation_applied_at',
      'arrival_cancellation_reason','authorised_amount_pence','discount_source',
      'dispatch_status','broadcast_enabled','current_broadcast_round','updated_at',
      'commission_wallet_enabled'
    ]
    WHEN 'drivers' THEN ARRAY[
      'id','driver_code','user_id','first_name','last_name','email','phone','is_online',
      'approval_status','driver_status','deleted_at','rating','total_trips','profile_photo_url',
      'created_at','updated_at','region_id','residential_address','postcode','city','country',
      'country_code','service_area_id','is_pet_friendly','documents_approved','category_id',
      'current_trip_id','onboarding_complete','current_lat','current_lng','heading',
      'last_location_updated_at','last_seen_at','payouts_enabled','payout_operational_paused',
      'charges_enabled','email_verified','phone_verified','terms_accepted_at','terms_version'
    ]
    WHEN 'customers' THEN ARRAY[
      'id','user_id','customer_code','first_name','last_name','phone','created_at','updated_at',
      'rider_status','email_verified','phone_verified','identity_verified_at','identity_provider',
      'name_edit_locked','name_unlocked_at','deleted_at','default_payment_method','wallet_balance'
    ]
    WHEN 'documents' THEN ARRAY[
      'id','driver_id','document_type','document_type_id','document_name','file_url','status',
      'expiry_date','notes','rejection_reason','reviewed_at','reviewed_by','created_at','updated_at',
      'is_current','superseded_by','last_reminded_at','reminder_sent_days','submission_idempotency_key',
      'upload_source','uploaded_by','admin_staff_id','uploaded_at',
      'vehicle_id','ambiguity_review_required'
    ]
    WHEN 'vehicles' THEN ARRAY[
      'id','driver_id','make','model','year','license_plate','color','approval_status','is_primary',
      'capacity','vehicle_type_id','rejection_reason','created_at','updated_at','is_enabled',
      'operational_status','is_trip_active','fleet_shared','suspended_reason','ambiguity_review_required'
    ]
    WHEN 'driver_service_areas' THEN ARRAY[
      'id','driver_id','service_area_id','created_at'
    ]
    WHEN 'fare_pricing_settings' THEN ARRAY[
      'id','service_area_id','vehicle_type_id','pricing_mode','currency_code',
      'base_fare_pence','per_km_rate_pence','per_min_rate_pence','booking_fee_pence',
      'minimum_fare_pence','free_waiting_minutes','waiting_per_minute_pence',
      'extra_stop_flat_fee_pence','recalculate_on_waiting','recalculate_on_stop_added',
      'recalculate_on_dropoff_changed','enable_surge','surge_multiplier_default',
      'peak_hour_multiplier','zone_multiplier','traffic_multiplier','demand_supply_multiplier',
      'distance_pricing_bands','cancellation_grace_period_minutes','cancellation_fee_pence',
      'cancellation_apply_after_arrival_only','late_cancel_enabled','late_cancel_threshold_minutes',
      'late_cancel_fee_pence','late_cancel_airport_protection_enabled',
      'late_cancel_airport_fare_threshold_pence','late_cancel_airport_fee_type',
      'late_cancel_airport_fee_percentage','late_cancel_airport_protection_trigger',
      'no_show_wait_time_minutes','no_show_fee_pence','no_show_apply_after_arrival_only',
      'arrival_cancellation_enabled','arrival_cancellation_fee_pence',
      'arrival_cancellation_apply_after_free_waiting_expired',
      'arrival_cancellation_after_arrival_only',
      'stop_waiting_grace_period_minutes','stop_waiting_rate_pence_per_minute',
      'created_at','updated_at'
    ]
    WHEN 'corporate_fare_rules' THEN ARRAY[
      'id','name','description','corporate_account_id','rule_type','discount_percentage',
      'fixed_rate','fare_cap','applies_to_vehicle_types','applies_to_regions',
      'time_restrictions','booking_restrictions','priority','is_active',
      'valid_from','valid_until','created_at','updated_at'
    ]
    WHEN 'document_types' THEN ARRAY[
      'id','name','slug','description','is_required','has_expiry','show_in_driver_app',
      'reminder_days_before_expiry','display_order','is_active','created_at','updated_at'
    ]
    WHEN 'service_area_document_rules' THEN ARRAY[
      'id','service_area_id','doc_type_id','display_in_driver_app','mandatory',
      'expiry_required','sort_order','is_active','created_at','updated_at'
    ]
    WHEN 'stop_waiting_settings' THEN ARRAY[
      'id','service_area_id','stop_radius_enabled','stop_radius_meters',
      'stop_waiting_grace_period_seconds','stop_waiting_charge_interval_seconds',
      'stop_waiting_rate_pence_per_minute','stop_waiting_max_minutes','created_at','updated_at'
    ]
    WHEN 'dispatch_settings' THEN ARRAY[
      'id','service_area_id','enable_stop_waiting_charge','stop_radius_enabled','stop_radius_meters',
      'stop_waiting_charge_interval_seconds','stop_waiting_grace_period_seconds',
      'stop_waiting_rate_pence_per_minute','stop_waiting_max_minutes',
      'max_driver_find_time_minutes','stacked_rides_enabled',
      'wave1_offer_expiry_seconds','wave2_offer_expiry_seconds','wave3_offer_expiry_seconds',
      'wave1_size','wave2_size','wave3_size','distance_penalty_per_km',
      'waiting_bonus_per_minute','max_waiting_bonus_minutes','fairness_idle_minutes',
      'fairness_boost_score','search_radius_start_km','search_radius_expand_km',
      'search_radius_max_km','updated_at','created_at'
    ]
    WHEN 'service_area_cancellation_fees' THEN ARRAY[
      'id','service_area_id','free_cancellation_window_minutes','cancellation_fee',
      'no_show_fee','currency_code','created_at','updated_at'
    ]
    WHEN 'service_area_vehicle_pricing' THEN ARRAY[
      'id','service_area_id','vehicle_type_id','is_enabled','base_fare','minimum_fare',
      'currency_code','per_km_rate_pence','per_min_rate_pence','airport_charge_pence',
      'created_at','updated_at'
    ]
    ELSE ARRAY[]::text[]
  END;
$$
;

CREATE OR REPLACE FUNCTION public._admin_page_mutate_columns(p_table text)
 RETURNS text[]
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO 'public', 'extensions'
AS $$
  SELECT CASE lower(p_table)
    WHEN 'drivers' THEN ARRAY[
      'first_name','last_name','email','phone','approval_status','driver_status','region_id',
      'residential_address','postcode','city','country','country_code','service_area_id',
      'is_pet_friendly','documents_approved','category_id','deleted_at','is_online','user_id'
    ]
    WHEN 'customers' THEN ARRAY[
      'first_name','last_name','phone','rider_status','updated_at','name_edit_locked','name_unlocked_at'
    ]
    WHEN 'documents' THEN ARRAY[
      'status','notes','rejection_reason','reviewed_at','reviewed_by','expiry_date','is_current',
      'superseded_by','last_reminded_at','reminder_sent_days','file_url','document_name'
    ]
    WHEN 'vehicles' THEN ARRAY[
      'approval_status','rejection_reason','is_primary','is_enabled','make','model','year',
      'license_plate','color','capacity','vehicle_type_id',
      'operational_status','is_trip_active','fleet_shared','suspended_reason'
    ]
    WHEN 'trips' THEN ARRAY[
      'passenger_id','passenger_name','passenger_phone','pickup_address','pickup_latitude',
      'pickup_longitude','dropoff_address','dropoff_latitude','dropoff_longitude','driver_id',
      'vehicle_type_id','vehicle_type','estimated_fare','estimated_distance_km',
      'estimated_duration_minutes','special_instructions','is_scheduled','scheduled_at','status',
      'scheduled_status','dispatch_mode','scheduled_broadcast_at','scheduled_convert_at',
      'confirmed_driver_id','scheduled_accepted_at','pending_release_kind','pending_release_at',
      'pending_release_driver_id','payment_method','payment_type','job_type','trip_type',
      'currency_code','service_area_id','booking_source','corporate_account_id','region_id',
      'financial_model','fare','final_fare_pence','gross_fare_pence','commission_pence',
      'driver_net_pence','commissionable_fare_pence','dispatch_status','broadcast_enabled',
      'current_broadcast_round','searching_expires_at','updated_at'
    ]
    WHEN 'driver_service_areas' THEN ARRAY[
      'driver_id','service_area_id'
    ]
    WHEN 'fare_pricing_settings' THEN ARRAY[
      'service_area_id','vehicle_type_id','pricing_mode','currency_code',
      'base_fare_pence','per_km_rate_pence','per_min_rate_pence','booking_fee_pence',
      'minimum_fare_pence','free_waiting_minutes','waiting_per_minute_pence',
      'extra_stop_flat_fee_pence','recalculate_on_waiting','recalculate_on_stop_added',
      'recalculate_on_dropoff_changed','enable_surge','surge_multiplier_default',
      'peak_hour_multiplier','zone_multiplier','traffic_multiplier','demand_supply_multiplier',
      'distance_pricing_bands','cancellation_grace_period_minutes','cancellation_fee_pence',
      'cancellation_apply_after_arrival_only','late_cancel_enabled','late_cancel_threshold_minutes',
      'late_cancel_fee_pence','late_cancel_airport_protection_enabled',
      'late_cancel_airport_fare_threshold_pence','late_cancel_airport_fee_type',
      'late_cancel_airport_fee_percentage','late_cancel_airport_protection_trigger',
      'no_show_wait_time_minutes','no_show_fee_pence','no_show_apply_after_arrival_only',
      'arrival_cancellation_enabled','arrival_cancellation_fee_pence',
      'arrival_cancellation_apply_after_free_waiting_expired',
      'arrival_cancellation_after_arrival_only',
      'stop_waiting_grace_period_minutes','stop_waiting_rate_pence_per_minute'
    ]
    WHEN 'corporate_fare_rules' THEN ARRAY[
      'name','description','corporate_account_id','rule_type','discount_percentage',
      'fixed_rate','fare_cap','applies_to_vehicle_types','applies_to_regions',
      'time_restrictions','booking_restrictions','priority','is_active',
      'valid_from','valid_until'
    ]
    WHEN 'document_types' THEN ARRAY[
      'name','slug','description','is_required','has_expiry','show_in_driver_app',
      'reminder_days_before_expiry','display_order','is_active'
    ]
    WHEN 'service_area_document_rules' THEN ARRAY[
      'service_area_id','doc_type_id','display_in_driver_app','mandatory',
      'expiry_required','sort_order','is_active'
    ]
    WHEN 'stop_waiting_settings' THEN ARRAY[
      'service_area_id','stop_radius_enabled','stop_radius_meters',
      'stop_waiting_grace_period_seconds','stop_waiting_charge_interval_seconds',
      'stop_waiting_rate_pence_per_minute','stop_waiting_max_minutes'
    ]
    WHEN 'dispatch_settings' THEN ARRAY[
      'service_area_id','enable_stop_waiting_charge','stop_radius_enabled','stop_radius_meters',
      'stop_waiting_charge_interval_seconds','stop_waiting_grace_period_seconds',
      'stop_waiting_rate_pence_per_minute','stop_waiting_max_minutes',
      'max_driver_find_time_minutes','stacked_rides_enabled',
      'wave1_offer_expiry_seconds','wave2_offer_expiry_seconds','wave3_offer_expiry_seconds',
      'wave1_size','wave2_size','wave3_size','distance_penalty_per_km',
      'waiting_bonus_per_minute','max_waiting_bonus_minutes','fairness_idle_minutes',
      'fairness_boost_score','search_radius_start_km','search_radius_expand_km',
      'search_radius_max_km','updated_at'
    ]
    WHEN 'service_area_cancellation_fees' THEN ARRAY[
      'service_area_id','free_cancellation_window_minutes','cancellation_fee',
      'no_show_fee','currency_code'
    ]
    WHEN 'service_area_vehicle_pricing' THEN ARRAY[
      'service_area_id','vehicle_type_id','is_enabled','base_fare','minimum_fare',
      'currency_code','per_km_rate_pence','per_min_rate_pence','airport_charge_pence','updated_at'
    ]
    ELSE ARRAY[]::text[]
  END;
$$
;

COMMIT;
