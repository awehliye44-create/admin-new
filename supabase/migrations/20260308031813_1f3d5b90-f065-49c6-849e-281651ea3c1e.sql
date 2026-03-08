
-- Create onecab_documents table
CREATE TABLE public.onecab_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  category text NOT NULL DEFAULT 'Other',
  document_type text,
  issuing_authority text,
  description text,
  reference_number text,
  issue_date date,
  expiry_date date,
  reminder_days_before integer NOT NULL DEFAULT 30,
  renewal_status text NOT NULL DEFAULT 'none' CHECK (renewal_status IN ('none', 'applied', 'pending', 'approved', 'received')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  file_name text,
  file_path text,
  mime_type text,
  notes text,
  uploaded_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- Indexes
CREATE INDEX idx_onecab_documents_category ON public.onecab_documents(category);
CREATE INDEX idx_onecab_documents_document_type ON public.onecab_documents(document_type);
CREATE INDEX idx_onecab_documents_issuing_authority ON public.onecab_documents(issuing_authority);
CREATE INDEX idx_onecab_documents_expiry_date ON public.onecab_documents(expiry_date);
CREATE INDEX idx_onecab_documents_status ON public.onecab_documents(status);

-- Activity log table
CREATE TABLE public.onecab_document_activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid REFERENCES public.onecab_documents(id) ON DELETE CASCADE,
  action text NOT NULL,
  details text,
  performed_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_onecab_doc_activity_document ON public.onecab_document_activity_log(document_id);
CREATE INDEX idx_onecab_doc_activity_created ON public.onecab_document_activity_log(created_at DESC);

-- Updated_at trigger
CREATE TRIGGER update_onecab_documents_updated_at
  BEFORE UPDATE ON public.onecab_documents
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- RLS
ALTER TABLE public.onecab_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onecab_document_activity_log ENABLE ROW LEVEL SECURITY;

-- Admin-only policies
CREATE POLICY "Admins can manage onecab_documents"
  ON public.onecab_documents
  FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can manage onecab_document_activity_log"
  ON public.onecab_document_activity_log
  FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Storage bucket for onecab documents
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'onecab-documents',
  'onecab-documents',
  false,
  20971520,
  ARRAY['application/pdf', 'image/jpeg', 'image/jpg', 'image/png', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']
) ON CONFLICT (id) DO NOTHING;

-- Storage policies
CREATE POLICY "Admins can upload onecab documents"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'onecab-documents' AND public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can read onecab documents"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (bucket_id = 'onecab-documents' AND public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can update onecab documents"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (bucket_id = 'onecab-documents' AND public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admins can delete onecab documents"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (bucket_id = 'onecab-documents' AND public.has_role(auth.uid(), 'admin'));
