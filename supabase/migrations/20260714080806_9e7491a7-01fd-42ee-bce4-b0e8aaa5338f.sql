
ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS superseded_by uuid NULL REFERENCES public.documents(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_documents_driver_type_current
  ON public.documents(driver_id, document_type) WHERE is_current;

-- Backfill with user triggers off so enforce_document_lock() does not fire
ALTER TABLE public.documents DISABLE TRIGGER USER;

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY driver_id, document_type
           ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
         ) AS rn
  FROM public.documents
  WHERE driver_id IS NOT NULL AND document_type IS NOT NULL
)
UPDATE public.documents d
SET is_current = (r.rn = 1)
FROM ranked r
WHERE d.id = r.id;

WITH current_rows AS (
  SELECT driver_id, document_type, id AS current_id
  FROM public.documents
  WHERE is_current = true
)
UPDATE public.documents d
SET superseded_by = c.current_id
FROM current_rows c
WHERE d.driver_id = c.driver_id
  AND d.document_type = c.document_type
  AND d.is_current = false
  AND d.superseded_by IS NULL
  AND d.id <> c.current_id;

ALTER TABLE public.documents ENABLE TRIGGER USER;

-- Supersession trigger
CREATE OR REPLACE FUNCTION public.trg_documents_mark_superseded()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.driver_id IS NULL OR NEW.document_type IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND (OLD.driver_id = NEW.driver_id
      AND OLD.document_type = NEW.document_type
      AND OLD.is_current = NEW.is_current) THEN
    RETURN NEW;
  END IF;

  IF NEW.is_current = true THEN
    UPDATE public.documents
       SET is_current = false,
           superseded_by = NEW.id
     WHERE driver_id = NEW.driver_id
       AND document_type = NEW.document_type
       AND id <> NEW.id
       AND is_current = true;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_documents_supersede ON public.documents;
CREATE TRIGGER trg_documents_supersede
  AFTER INSERT OR UPDATE OF driver_id, document_type, is_current
  ON public.documents
  FOR EACH ROW
  EXECUTE FUNCTION public.trg_documents_mark_superseded();

-- Canonical compliance view
DROP VIEW IF EXISTS public.driver_document_compliance_ssot CASCADE;
CREATE VIEW public.driver_document_compliance_ssot
WITH (security_invoker = on, security_barrier = true) AS
WITH current_docs AS (
  SELECT d.driver_id, d.document_type, d.id AS document_id, d.status, d.expiry_date,
         d.file_url, d.updated_at, d.is_current, d.superseded_by
  FROM public.documents d
  WHERE d.is_current = true
),
today_london AS (
  SELECT (now() AT TIME ZONE 'Europe/London')::date AS today
)
SELECT
  dr.id                                        AS driver_id,
  dt.id                                        AS document_type_id,
  dt.slug                                      AS document_type_key,
  dt.name                                      AS display_name,
  dt.is_required,
  dt.has_expiry,
  cd.document_id,
  cd.status                                    AS approval_status,
  cd.expiry_date,
  cd.file_url,
  cd.updated_at                                AS last_updated_at,
  cd.superseded_by                             AS replacement_document_id,
  COALESCE(cd.is_current, false)               AS is_current,
  (cd.document_id IS NOT NULL AND cd.is_current = false) AS is_superseded,
  CASE
    WHEN cd.document_id IS NULL                                             THEN 'missing'
    WHEN lower(coalesce(cd.status,'')) IN ('rejected','declined')           THEN 'rejected'
    WHEN lower(coalesce(cd.status,'')) IN ('pending','uploaded','submitted')THEN 'pending'
    WHEN dt.has_expiry AND cd.expiry_date IS NOT NULL
         AND cd.expiry_date < (SELECT today FROM today_london)              THEN 'expired'
    WHEN dt.has_expiry AND cd.expiry_date IS NOT NULL
         AND lower(coalesce(cd.status,'')) = 'approved'
         AND cd.expiry_date <= ((SELECT today FROM today_london) + INTERVAL '7 days')::date
                                                                            THEN 'expiring_soon'
    WHEN lower(coalesce(cd.status,'')) = 'approved'                         THEN 'approved_valid'
    ELSE 'pending'
  END                                          AS expiry_status,
  CASE WHEN cd.expiry_date IS NULL THEN NULL
       ELSE (cd.expiry_date - (SELECT today FROM today_london)) END         AS days_until_expiry,
  (
    dt.is_required
    AND (
      cd.document_id IS NULL
      OR lower(coalesce(cd.status,'')) IN ('rejected','declined')
      OR (dt.has_expiry AND cd.expiry_date IS NOT NULL AND cd.expiry_date < (SELECT today FROM today_london))
    )
  )                                            AS blocks_online
FROM public.drivers dr
CROSS JOIN public.document_types dt
LEFT JOIN current_docs cd
  ON cd.driver_id = dr.id AND cd.document_type = dt.slug
WHERE dt.is_active = true
  AND (dt.is_required = true OR cd.document_id IS NOT NULL);

GRANT SELECT ON public.driver_document_compliance_ssot TO authenticated;

-- RPC
CREATE OR REPLACE FUNCTION public.get_driver_document_compliance(_driver_id uuid DEFAULT NULL)
RETURNS SETOF public.driver_document_compliance_ssot
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_target uuid;
  v_is_privileged boolean;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;

  v_is_privileged := public.has_role(v_uid, 'admin')
                  OR public.has_role(v_uid, 'staff')
                  OR public.has_role(v_uid, 'super_admin');

  IF _driver_id IS NOT NULL THEN
    IF NOT v_is_privileged THEN
      SELECT id INTO v_target FROM public.drivers WHERE user_id = v_uid LIMIT 1;
      IF v_target IS NULL OR v_target <> _driver_id THEN
        RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
      END IF;
    END IF;
    v_target := _driver_id;
  ELSE
    SELECT id INTO v_target FROM public.drivers WHERE user_id = v_uid LIMIT 1;
    IF v_target IS NULL THEN
      RAISE EXCEPTION 'no_driver_profile' USING ERRCODE = 'P0002';
    END IF;
  END IF;

  RETURN QUERY
  SELECT * FROM public.driver_document_compliance_ssot
  WHERE driver_id = v_target
  ORDER BY
    CASE expiry_status
      WHEN 'expired'       THEN 1
      WHEN 'rejected'      THEN 2
      WHEN 'missing'       THEN 3
      WHEN 'expiring_soon' THEN 4
      WHEN 'pending'       THEN 5
      WHEN 'approved_valid'THEN 6
      ELSE 7
    END,
    display_name;
END;
$$;

REVOKE ALL ON FUNCTION public.get_driver_document_compliance(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.get_driver_document_compliance(uuid) TO authenticated;
