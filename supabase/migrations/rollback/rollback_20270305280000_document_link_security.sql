-- Emergency rollback for 20270305280000_document_link_security.
-- Preimage on thazislrdkjpvvghtvzo before apply (no row data):
--   resolve_md5 1750d9d1c8bd24e61d42e79be16b7b25
--   stamp_md5   f5eb427a9166b90d6c2b790628323dd1
--   elig_md5    0e6892b5582b47127a8c5c5bc5e5b84a
--   view_md5    20f265282bfbc91c99b5738a2ff45fff
--   view_options null (security_invoker off)
--   anon SELECT on the view, authenticated EXECUTE on both internal helpers.
-- Restores the previous (weaker) grants and the primary/oldest guess.
-- Run only to recover a failed apply. Do not db push this file.
-- After it succeeds, delete the schema_migrations row for 20270305280000
-- so a corrected migration can be recorded again.

BEGIN;

DROP TRIGGER IF EXISTS documents_freeze_vehicle_link ON public.documents;
DROP FUNCTION IF EXISTS public.trg_documents_freeze_vehicle_link();

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

CREATE OR REPLACE FUNCTION public.trg_documents_stamp_vehicle_id()
RETURNS trigger
LANGUAGE plpgsql
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

  IF NEW.vehicle_id IS NULL THEN
    NEW.vehicle_id := v_target;
  ELSE
    PERFORM public.assert_document_vehicle_ownership(NEW.driver_id, NEW.vehicle_id);
    IF v_target IS NOT NULL AND NEW.vehicle_id IS DISTINCT FROM v_target THEN
      IF EXISTS (
        SELECT 1 FROM public.vehicle_change_requests r
         WHERE r.driver_id = NEW.driver_id
           AND r.status = 'pending'
           AND r.requested_vehicle_id = v_target
      ) THEN
        NEW.vehicle_id := v_target;
      END IF;
    END IF;
  END IF;

  PERFORM public.assert_document_vehicle_ownership(NEW.driver_id, NEW.vehicle_id);
  RETURN NEW;
END;
$$;

-- Previous compliance view matched a NULL trip-active id to unlinked vehicle docs
-- and was not security_invoker. Recreate that shape, then clear the option.
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
    dt.is_required AND (cd.document_id IS NULL OR (lower(COALESCE(cd.status, ''::text)) = ANY (ARRAY['rejected'::text, 'declined'::text])) OR dt.has_expiry AND cd.expiry_date IS NOT NULL AND cd.expiry_date < (( SELECT today_london.today FROM today_london))) AS blocks_online
   FROM drivers dr
     CROSS JOIN document_types dt
     LEFT JOIN current_docs cd ON cd.driver_id = dr.id AND cd.document_type = dt.slug
  WHERE dt.is_active = true AND (dt.is_required = true OR cd.document_id IS NOT NULL);

ALTER VIEW public.driver_document_compliance_ssot RESET (security_invoker);
GRANT ALL ON TABLE public.driver_document_compliance_ssot TO anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.vehicle_change_applicable_documents(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_driver_document_eligibility_internal(uuid) TO authenticated, service_role;

DELETE FROM supabase_migrations.schema_migrations WHERE version = '20270305280000';

COMMIT;
