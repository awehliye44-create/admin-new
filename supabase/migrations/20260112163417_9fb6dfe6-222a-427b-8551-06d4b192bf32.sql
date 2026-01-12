-- Drop the security definer view and recreate it as a regular view
DROP VIEW IF EXISTS public.driver_document_status;

-- Recreate view without SECURITY DEFINER (regular views inherit the caller's permissions)
CREATE VIEW public.driver_document_status AS
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

-- Grant access to the view
GRANT SELECT ON public.driver_document_status TO authenticated;