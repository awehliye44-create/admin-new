-- P0: Remove legacy driver_license SA rule when dvla_driving_license is already mandatory.
-- Seed incorrectly required both; drivers upload dvla_driving_license only, which blocked go-online.

DELETE FROM public.service_area_document_rules sar
USING public.document_types dt_legacy,
      public.document_types dt_dvla,
      public.service_area_document_rules sar_dvla
WHERE sar.doc_type_id = dt_legacy.id
  AND dt_legacy.slug = 'driver_license'
  AND dt_dvla.slug = 'dvla_driving_license'
  AND sar_dvla.service_area_id = sar.service_area_id
  AND sar_dvla.doc_type_id = dt_dvla.id
  AND sar_dvla.is_active = true
  AND sar_dvla.mandatory = true;

-- Recalc compliance cache.
UPDATE public.drivers d
SET
  documents_approved = public.check_driver_documents_approved(d.id),
  updated_at = now()
WHERE d.documents_approved IS DISTINCT FROM public.check_driver_documents_approved(d.id)
   OR d.documents_approved = false;
