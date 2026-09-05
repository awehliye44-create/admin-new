-- Re-seed service areas that still have zero driver-app document rules
-- (e.g. Banadir added after the original MK seed). Without rules, My Documents
-- shows an empty catalogue for new drivers in that area.

BEGIN;

INSERT INTO public.service_area_document_rules (
  service_area_id,
  doc_type_id,
  display_in_driver_app,
  mandatory,
  expiry_required,
  sort_order,
  is_active
)
SELECT
  sa.id,
  dt.id,
  true,
  COALESCE(dt.is_required, true),
  COALESCE(dt.has_expiry, true),
  COALESCE(dt.display_order, 100),
  true
FROM public.service_areas sa
CROSS JOIN public.document_types dt
WHERE dt.is_active = true
  AND COALESCE(dt.is_required, true) = true
  AND NOT EXISTS (
    SELECT 1
    FROM public.service_area_document_rules sar
    WHERE sar.service_area_id = sa.id
      AND sar.is_active = true
      AND sar.display_in_driver_app = true
  )
ON CONFLICT (service_area_id, doc_type_id) DO NOTHING;

COMMIT;
