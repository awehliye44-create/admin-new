CREATE OR REPLACE FUNCTION public.trg_documents_demote_current_before()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.driver_id IS NULL OR NEW.document_type IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.driver_id = NEW.driver_id
     AND OLD.document_type = NEW.document_type
     AND OLD.is_current = NEW.is_current THEN
    RETURN NEW;
  END IF;

  IF NEW.is_current = true THEN
    UPDATE public.documents
       SET is_current = false,
           updated_at = now()
     WHERE driver_id = NEW.driver_id
       AND document_type = NEW.document_type
       AND id IS DISTINCT FROM NEW.id
       AND is_current = true;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_documents_link_superseded_after()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.driver_id IS NULL OR NEW.document_type IS NULL OR NEW.is_current IS DISTINCT FROM true THEN
    RETURN NEW;
  END IF;

  UPDATE public.documents
     SET superseded_by = NEW.id,
         updated_at = now()
   WHERE driver_id = NEW.driver_id
     AND document_type = NEW.document_type
     AND id IS DISTINCT FROM NEW.id
     AND is_current = false
     AND superseded_by IS NULL;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_documents_supersede ON public.documents;
DROP TRIGGER IF EXISTS trg_documents_link_superseded_after ON public.documents;

CREATE TRIGGER trg_documents_demote_current_before
BEFORE INSERT OR UPDATE OF driver_id, document_type, is_current
ON public.documents
FOR EACH ROW
EXECUTE FUNCTION public.trg_documents_demote_current_before();

CREATE TRIGGER trg_documents_link_superseded_after
AFTER INSERT OR UPDATE OF driver_id, document_type, is_current
ON public.documents
FOR EACH ROW
EXECUTE FUNCTION public.trg_documents_link_superseded_after();

DROP FUNCTION IF EXISTS public.trg_documents_mark_superseded();