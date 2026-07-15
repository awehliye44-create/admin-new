
DROP INDEX IF EXISTS public.idx_documents_driver_type_current;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_documents_driver_type_current
  ON public.documents (driver_id, document_type)
  WHERE is_current = true;
