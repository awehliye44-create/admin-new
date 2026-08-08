CREATE TABLE public.website_enquiries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key text NOT NULL UNIQUE,
  form_type text NOT NULL CHECK (form_type IN ('contact','driver_application')),
  name text NOT NULL,
  email text NOT NULL,
  phone text,
  license text,
  experience text,
  message text,
  source text,
  ip_hash text,
  email_status text NOT NULL DEFAULT 'pending',
  email_error text,
  provider_message_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON public.website_enquiries TO service_role;

ALTER TABLE public.website_enquiries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role manages website enquiries"
ON public.website_enquiries FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE INDEX idx_website_enquiries_ip_hash_created_at
  ON public.website_enquiries (ip_hash, created_at DESC);

CREATE TRIGGER update_website_enquiries_updated_at
BEFORE UPDATE ON public.website_enquiries
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();