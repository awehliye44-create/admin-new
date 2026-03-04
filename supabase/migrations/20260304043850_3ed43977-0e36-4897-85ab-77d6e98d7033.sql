
-- Create app_scope enum
CREATE TYPE public.app_scope AS ENUM ('customer', 'driver', 'corporate', 'shared');

-- Create content_status enum
CREATE TYPE public.content_status AS ENUM ('draft', 'published');

-- Create content_items table
CREATE TABLE public.content_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_scope app_scope NOT NULL,
  slug VARCHAR NOT NULL,
  title VARCHAR NOT NULL,
  content_html TEXT NOT NULL DEFAULT '',
  status content_status NOT NULL DEFAULT 'draft',
  version INT NOT NULL DEFAULT 1,
  change_log TEXT,
  updated_by UUID REFERENCES auth.users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  published_by UUID REFERENCES auth.users(id),
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (app_scope, slug, version)
);

-- Enable RLS
ALTER TABLE public.content_items ENABLE ROW LEVEL SECURITY;

-- Admin can do everything
CREATE POLICY "Admins can manage content"
ON public.content_items FOR ALL TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Public read for published content (for apps/website)
CREATE POLICY "Anyone can read published content"
ON public.content_items FOR SELECT TO anon, authenticated
USING (status = 'published');

-- Create content_audit_log table
CREATE TABLE public.content_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_item_id UUID REFERENCES public.content_items(id) ON DELETE CASCADE NOT NULL,
  action VARCHAR NOT NULL,
  user_id UUID REFERENCES auth.users(id),
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.content_audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage content audit log"
ON public.content_audit_log FOR ALL TO authenticated
USING (public.has_role(auth.uid(), 'admin'))
WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- Seed initial content slugs
INSERT INTO public.content_items (app_scope, slug, title, content_html, status, version) VALUES
  ('shared', 'company_name', 'Company Name', 'OneCab', 'published', 1),
  ('shared', 'support_phone', 'Support Phone', '01908 831211', 'published', 1),
  ('shared', 'whatsapp_phone', 'WhatsApp Phone', '07919 111062', 'published', 1),
  ('shared', 'support_email', 'Support Email', 'support@onecab.co.uk', 'published', 1),
  ('customer', 'about_us', 'About Us (Customer)', '', 'draft', 1),
  ('customer', 'terms', 'Terms & Conditions (Customer)', '', 'draft', 1),
  ('customer', 'privacy_policy', 'Privacy Policy (Customer)', '', 'draft', 1),
  ('driver', 'about_us', 'About Us (Driver)', '', 'draft', 1),
  ('driver', 'terms', 'Terms & Conditions (Driver)', '', 'draft', 1),
  ('driver', 'privacy_policy', 'Privacy Policy (Driver)', '', 'draft', 1),
  ('corporate', 'corporate_page', 'Corporate Page Content', '', 'draft', 1);
