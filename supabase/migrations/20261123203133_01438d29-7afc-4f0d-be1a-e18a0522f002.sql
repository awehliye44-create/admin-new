CREATE OR REPLACE FUNCTION public.documents_clear_stale_rejection_reason()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.status IS DISTINCT FROM 'rejected' THEN
    NEW.rejection_reason := NULL;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.documents_clear_stale_rejection_reason() FROM PUBLIC, anon, authenticated;

-- "zz_" so it fires after every other BEFORE trigger that may change status
DROP TRIGGER IF EXISTS zz_documents_clear_stale_rejection_reason ON public.documents;
CREATE TRIGGER zz_documents_clear_stale_rejection_reason
  BEFORE INSERT OR UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.documents_clear_stale_rejection_reason();