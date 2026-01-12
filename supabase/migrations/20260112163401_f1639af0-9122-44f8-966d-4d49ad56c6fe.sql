-- Add documents_approved column to drivers table to track if all required documents are approved
ALTER TABLE public.drivers 
ADD COLUMN IF NOT EXISTS documents_approved boolean NOT NULL DEFAULT false;

-- Create a function to check if all required documents for a driver are approved
CREATE OR REPLACE FUNCTION public.check_driver_documents_approved(p_driver_id uuid)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  required_docs text[] := ARRAY[
    'private_hire_insurance',
    'mot_certificate', 
    'phv_license',
    'dvla_check_code',
    'phd_badge',
    'phl_license',
    'dvla_driving_license',
    'profile_photo',
    'v5_logbook',
    'utr_number',
    'national_insurance'
  ];
  approved_count integer;
BEGIN
  SELECT COUNT(DISTINCT document_type)
  INTO approved_count
  FROM public.documents
  WHERE driver_id = p_driver_id
    AND document_type = ANY(required_docs)
    AND status = 'approved';
  
  RETURN approved_count >= array_length(required_docs, 1);
END;
$$;

-- Create a function to update driver document approval status
CREATE OR REPLACE FUNCTION public.update_driver_document_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Update the driver's documents_approved status
  UPDATE public.drivers
  SET 
    documents_approved = public.check_driver_documents_approved(COALESCE(NEW.driver_id, OLD.driver_id)),
    updated_at = now()
  WHERE id = COALESCE(NEW.driver_id, OLD.driver_id);
  
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Create trigger to auto-update driver document status when documents change
DROP TRIGGER IF EXISTS update_driver_docs_status ON public.documents;
CREATE TRIGGER update_driver_docs_status
  AFTER INSERT OR UPDATE OR DELETE ON public.documents
  FOR EACH ROW
  EXECUTE FUNCTION public.update_driver_document_status();

-- Create a view to see driver document completion status
CREATE OR REPLACE VIEW public.driver_document_status AS
SELECT 
  d.id as driver_id,
  d.first_name,
  d.last_name,
  d.documents_approved,
  d.approval_status,
  COUNT(doc.id) FILTER (WHERE doc.status = 'approved') as approved_docs,
  COUNT(doc.id) FILTER (WHERE doc.status = 'pending') as pending_docs,
  COUNT(doc.id) FILTER (WHERE doc.status = 'rejected') as rejected_docs,
  11 as required_docs_count,
  CASE 
    WHEN d.documents_approved THEN 'All Documents Approved'
    WHEN COUNT(doc.id) FILTER (WHERE doc.status = 'rejected') > 0 THEN 'Documents Rejected'
    WHEN COUNT(doc.id) FILTER (WHERE doc.status = 'pending') > 0 THEN 'Pending Review'
    ELSE 'Documents Missing'
  END as document_status
FROM public.drivers d
LEFT JOIN public.documents doc ON doc.driver_id = d.id
GROUP BY d.id, d.first_name, d.last_name, d.documents_approved, d.approval_status;