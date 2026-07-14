-- Driver document SSOT audit — run read-only in prod
-- 1. Duplicate current rows per (driver, doc_type) — should be 0 after migration
SELECT driver_id, document_type, count(*) AS current_rows
FROM public.documents
WHERE is_current = true
GROUP BY 1, 2
HAVING count(*) > 1
ORDER BY 3 DESC;

-- 2. Documents not attached to any driver row
SELECT id, driver_id, document_type, status, expiry_date, created_at
FROM public.documents d
WHERE driver_id IS NULL
   OR NOT EXISTS (SELECT 1 FROM public.drivers dr WHERE dr.id = d.driver_id)
ORDER BY created_at DESC
LIMIT 100;

-- 3. Documents referring to a document_type slug that no longer exists in document_types
SELECT d.id, d.driver_id, d.document_type, d.status, d.expiry_date
FROM public.documents d
LEFT JOIN public.document_types dt ON dt.slug = d.document_type
WHERE dt.id IS NULL
ORDER BY d.updated_at DESC
LIMIT 100;

-- 4. Drivers with expired mandatory documents (blocks_online = true)
SELECT driver_id,
       array_agg(document_type_key ORDER BY document_type_key)
         FILTER (WHERE expiry_status = 'expired')     AS expired_types,
       array_agg(document_type_key ORDER BY document_type_key)
         FILTER (WHERE expiry_status = 'rejected')    AS rejected_types,
       array_agg(document_type_key ORDER BY document_type_key)
         FILTER (WHERE expiry_status = 'missing')     AS missing_types
FROM public.driver_document_compliance_ssot
WHERE blocks_online = true
GROUP BY driver_id
ORDER BY driver_id;

-- 5. Compliance snapshot for a single driver (parameterise :driver_id)
-- SELECT document_type_key, display_name, approval_status, expiry_date,
--        expiry_status, days_until_expiry, is_superseded, blocks_online
-- FROM public.driver_document_compliance_ssot
-- WHERE driver_id = :'driver_id'
-- ORDER BY CASE expiry_status
--   WHEN 'expired' THEN 1 WHEN 'rejected' THEN 2 WHEN 'missing' THEN 3
--   WHEN 'expiring_soon' THEN 4 WHEN 'pending' THEN 5 ELSE 6 END,
--   display_name;
