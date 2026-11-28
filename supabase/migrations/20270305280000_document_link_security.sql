-- Document link security.
-- Closes live holes without changing the vehicle-change workflow:
--   * compliance view runs as the invoker so underlying RLS applies
--   * anonymous and broad client execute removed from internal helpers
--   * a driver cannot rewrite driver_id / vehicle_id on an existing row
--   * a new vehicle document is never guessed onto primary/oldest
-- Ambiguous vehicle documents stay vehicle_id NULL and flagged for Admin resolve.
-- Does not depend on 20270305240000–20270305270000.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Caller-bound access. Internal helpers stay owner/service only.
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.vehicle_change_applicable_documents(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vehicle_change_applicable_documents(uuid) TO service_role;

REVOKE ALL ON FUNCTION public.get_driver_document_eligibility_internal(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_driver_document_eligibility_internal(uuid) TO service_role;

-- Driver app entry points. These bind auth.uid() / current driver before reading.
GRANT EXECUTE ON FUNCTION public.get_driver_document_eligibility(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_my_vehicle_change_applicable_documents() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_driver_document_compliance(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_trip_active_vehicle_id(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_driver_document_eligibility_internal(uuid) IS
  'Trusted arbitrary-driver document eligibility. No auth.uid() check. Callable by the owner and service_role only. Drivers use get_driver_document_eligibility.';

COMMENT ON FUNCTION public.vehicle_change_applicable_documents(uuid) IS
  'Replacement vehicle document requirements for a driver id. No auth.uid() check. Drivers use get_my_vehicle_change_applicable_documents. Admin RPCs call this as the owner.';

-- Unlinked vehicle documents must not count when there is no trip-active vehicle.
-- NULL IS NOT DISTINCT FROM NULL previously treated them as the current vehicle.
DO $patch_elig$
DECLARE
  v_src text;
  v_new text;
  v_old text := 'OR d.vehicle_id IS NOT DISTINCT FROM public.resolve_trip_active_vehicle_id(p_driver_id)';
  v_fix text := 'OR (public.resolve_trip_active_vehicle_id(p_driver_id) IS NOT NULL AND d.vehicle_id = public.resolve_trip_active_vehicle_id(p_driver_id))';
BEGIN
  SELECT pg_get_functiondef('public.get_driver_document_eligibility_internal(uuid)'::regprocedure)
    INTO v_src;
  IF position(v_old in v_src) = 0 THEN
    IF position(v_fix in v_src) > 0 THEN
      RAISE NOTICE 'eligibility vehicle match already fail-closed';
      RETURN;
    END IF;
    RAISE EXCEPTION 'eligibility vehicle predicate not found; refusing to continue';
  END IF;
  v_new := replace(v_src, v_old, v_fix);
  EXECUTE v_new;
END
$patch_elig$;

-- Re-revoke after CREATE OR REPLACE (grants survive replace; do not leave authenticated on).
REVOKE ALL ON FUNCTION public.get_driver_document_eligibility_internal(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_driver_document_eligibility_internal(uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. Resolve a vehicle only when one is established. Never guess.
-- ---------------------------------------------------------------------------

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
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_vehicle_document_target(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_vehicle_document_target(uuid) TO service_role;

COMMENT ON FUNCTION public.resolve_vehicle_document_target(uuid) IS
  'Pending replacement vehicle, else the trip-active vehicle, else NULL. Does not guess primary or oldest.';

-- ---------------------------------------------------------------------------
-- 3. Stamp: established target, or explicitly unlinked for Admin.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.trg_documents_stamp_vehicle_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_target uuid;
BEGIN
  IF NOT public.is_vehicle_scoped_document_slug(NEW.document_type) THEN
    NEW.vehicle_id := NULL;
    RETURN NEW;
  END IF;

  v_target := public.resolve_vehicle_document_target(NEW.driver_id);

  IF v_target IS NULL THEN
    -- Fail closed: do not attach this file to a guessed vehicle.
    NEW.vehicle_id := NULL;
    NEW.ambiguity_review_required := true;
    RETURN NEW;
  END IF;

  NEW.vehicle_id := v_target;
  NEW.ambiguity_review_required := false;
  PERFORM public.assert_document_vehicle_ownership(NEW.driver_id, NEW.vehicle_id);
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.trg_documents_stamp_vehicle_id() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. Existing rows: a driver cannot move driver_id or vehicle_id.
--    Owner-executed Admin RPCs (admin_page_mutate, admin_resolve) still can.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.trg_documents_freeze_vehicle_link()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF OLD.driver_id IS NOT DISTINCT FROM NEW.driver_id
     AND OLD.vehicle_id IS NOT DISTINCT FROM NEW.vehicle_id THEN
    RETURN NEW;
  END IF;

  IF current_user IN ('postgres', 'supabase_admin', 'service_role') THEN
    RETURN NEW;
  END IF;

  IF current_setting('onecab.admin_page_mutate', true) = '1' THEN
    RETURN NEW;
  END IF;

  IF auth.uid() IS NOT NULL AND (
       public.has_role(auth.uid(), 'admin'::app_role)
       OR public.staff_is_active_owner()
       OR public.staff_has_any_page_access(ARRAY['documents', 'document-management', 'drivers'])
     ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'DOCUMENT_LINK_IMMUTABLE' USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.trg_documents_freeze_vehicle_link() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS documents_freeze_vehicle_link ON public.documents;
CREATE TRIGGER documents_freeze_vehicle_link
  BEFORE UPDATE OF driver_id, vehicle_id ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.trg_documents_freeze_vehicle_link();

-- ---------------------------------------------------------------------------
-- 5. Compliance view enforces the invoker's RLS.
--    Vehicle documents require a real trip-active vehicle id.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW public.driver_document_compliance_ssot AS
 WITH targets AS (
         SELECT dr.id AS driver_id,
            public.resolve_trip_active_vehicle_id(dr.id) AS vehicle_id
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
              OR (
                t.vehicle_id IS NOT NULL
                AND d.vehicle_id = t.vehicle_id
              )
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
    dt.is_required AND (cd.document_id IS NULL OR (lower(COALESCE(cd.status, ''::text)) = ANY (ARRAY['rejected'::text, 'declined'::text])) OR dt.has_expiry AND cd.expiry_date IS NOT NULL AND cd.expiry_date < (( SELECT today_london.today FROM today_london))) AS blocks_online
   FROM drivers dr
     CROSS JOIN document_types dt
     LEFT JOIN current_docs cd ON cd.driver_id = dr.id AND cd.document_type = dt.slug
  WHERE dt.is_active = true AND (dt.is_required = true OR cd.document_id IS NOT NULL);

ALTER VIEW public.driver_document_compliance_ssot SET (security_invoker = on);

REVOKE ALL ON TABLE public.driver_document_compliance_ssot FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.driver_document_compliance_ssot FROM authenticated;
GRANT SELECT ON TABLE public.driver_document_compliance_ssot TO authenticated, service_role;

COMMENT ON VIEW public.driver_document_compliance_ssot IS
  'Driver document compliance for the invoker. security_invoker so documents/drivers RLS applies. Vehicle rows require the trip-active vehicle. Drivers read this view for their own profile; staff read through get_driver_document_compliance.';

COMMIT;
