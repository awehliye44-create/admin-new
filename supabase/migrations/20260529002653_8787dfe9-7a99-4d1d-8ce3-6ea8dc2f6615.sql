
-- ============================================================
-- MERCHANT MANAGEMENT (Marketplace) schema
-- ============================================================

-- Enum for merchant categories
CREATE TYPE public.merchant_category AS ENUM ('food','grocery','retail','pharmacy','parcel');
CREATE TYPE public.merchant_status AS ENUM ('pending','approved','rejected','suspended','closed');
CREATE TYPE public.merchant_image_source AS ENUM ('uploaded','ai_generated');

-- 1) Global merchant category enabled flags (singleton-ish: one row per category)
CREATE TABLE public.merchant_categories (
  category public.merchant_category PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  display_name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.merchant_categories TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.merchant_categories TO authenticated;
GRANT ALL ON public.merchant_categories TO service_role;
ALTER TABLE public.merchant_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public can read merchant categories"
  ON public.merchant_categories FOR SELECT USING (true);
CREATE POLICY "Admins manage merchant categories"
  ON public.merchant_categories FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin'))
  WITH CHECK (public.has_role(auth.uid(),'admin'));

INSERT INTO public.merchant_categories (category, enabled, display_name) VALUES
  ('food', true, 'Food'),
  ('grocery', true, 'Grocery'),
  ('retail', true, 'Retail'),
  ('pharmacy', true, 'Pharmacy'),
  ('parcel', true, 'Parcel');

-- 2) Per-service-area merchant settings
CREATE TABLE public.service_area_merchant_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service_area_id uuid NOT NULL REFERENCES public.service_areas(id) ON DELETE CASCADE,
  category public.merchant_category NOT NULL,
  delivery_enabled boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (service_area_id, category)
);
CREATE INDEX idx_sa_merchant_settings_sa ON public.service_area_merchant_settings(service_area_id);
GRANT SELECT ON public.service_area_merchant_settings TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.service_area_merchant_settings TO authenticated;
GRANT ALL ON public.service_area_merchant_settings TO service_role;
ALTER TABLE public.service_area_merchant_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public can read sa merchant settings"
  ON public.service_area_merchant_settings FOR SELECT USING (true);
CREATE POLICY "Admins manage sa merchant settings"
  ON public.service_area_merchant_settings FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin'))
  WITH CHECK (public.has_role(auth.uid(),'admin'));

-- 3) Merchants
CREATE TABLE public.merchants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name text NOT NULL,
  category public.merchant_category NOT NULL,
  service_area_id uuid NOT NULL REFERENCES public.service_areas(id) ON DELETE RESTRICT,
  description text,
  owner_name text,
  phone text,
  email text,
  address text,
  city text,
  postcode text,
  logo_url text,
  banner_url text,
  opening_hours jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_open boolean NOT NULL DEFAULT true,
  prep_time_minutes integer NOT NULL DEFAULT 20,
  delivery_radius_km numeric NOT NULL DEFAULT 5,
  min_order_amount numeric NOT NULL DEFAULT 0,
  commission_pct numeric,  -- null = use global 15%
  status public.merchant_status NOT NULL DEFAULT 'pending',
  owner_user_id uuid,  -- optional link to auth.users
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_merchants_sa ON public.merchants(service_area_id);
CREATE INDEX idx_merchants_status ON public.merchants(status);
CREATE INDEX idx_merchants_category ON public.merchants(category);
GRANT SELECT ON public.merchants TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.merchants TO authenticated;
GRANT ALL ON public.merchants TO service_role;
ALTER TABLE public.merchants ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public can read approved merchants"
  ON public.merchants FOR SELECT USING (status = 'approved');
CREATE POLICY "Admins read all merchants"
  ON public.merchants FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'admin'));
CREATE POLICY "Admins manage merchants"
  ON public.merchants FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin'))
  WITH CHECK (public.has_role(auth.uid(),'admin'));

-- 4) Product categories (per merchant)
CREATE TABLE public.merchant_product_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES public.merchants(id) ON DELETE CASCADE,
  name text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_mpc_merchant ON public.merchant_product_categories(merchant_id);
GRANT SELECT ON public.merchant_product_categories TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.merchant_product_categories TO authenticated;
GRANT ALL ON public.merchant_product_categories TO service_role;
ALTER TABLE public.merchant_product_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read product categories"
  ON public.merchant_product_categories FOR SELECT USING (true);
CREATE POLICY "Admins manage product categories"
  ON public.merchant_product_categories FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin'))
  WITH CHECK (public.has_role(auth.uid(),'admin'));

-- 5) Products / menu items
CREATE TABLE public.merchant_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES public.merchants(id) ON DELETE CASCADE,
  product_category_id uuid REFERENCES public.merchant_product_categories(id) ON DELETE SET NULL,
  name text NOT NULL,
  description text,
  price numeric NOT NULL DEFAULT 0,
  image_url text,
  image_source public.merchant_image_source NOT NULL DEFAULT 'uploaded',
  image_approved boolean NOT NULL DEFAULT true,
  availability boolean NOT NULL DEFAULT true,
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_products_merchant ON public.merchant_products(merchant_id);
GRANT SELECT ON public.merchant_products TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.merchant_products TO authenticated;
GRANT ALL ON public.merchant_products TO service_role;
ALTER TABLE public.merchant_products ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Public read available products"
  ON public.merchant_products FOR SELECT USING (availability = true AND image_approved = true);
CREATE POLICY "Admins read all products"
  ON public.merchant_products FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'admin'));
CREATE POLICY "Admins manage products"
  ON public.merchant_products FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin'))
  WITH CHECK (public.has_role(auth.uid(),'admin'));

-- 6) AI credits (per merchant)
CREATE TABLE public.merchant_ai_credits (
  merchant_id uuid PRIMARY KEY REFERENCES public.merchants(id) ON DELETE CASCADE,
  credits_remaining integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.merchant_ai_credits TO authenticated;
GRANT ALL ON public.merchant_ai_credits TO service_role;
ALTER TABLE public.merchant_ai_credits ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins manage ai credits"
  ON public.merchant_ai_credits FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin'))
  WITH CHECK (public.has_role(auth.uid(),'admin'));

-- 7) AI generation history
CREATE TABLE public.merchant_ai_generations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  merchant_id uuid NOT NULL REFERENCES public.merchants(id) ON DELETE CASCADE,
  product_id uuid REFERENCES public.merchant_products(id) ON DELETE SET NULL,
  prompt text NOT NULL,
  image_url text,
  status text NOT NULL DEFAULT 'pending', -- pending|completed|failed|approved|rejected
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_ai_gen_merchant ON public.merchant_ai_generations(merchant_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.merchant_ai_generations TO authenticated;
GRANT ALL ON public.merchant_ai_generations TO service_role;
ALTER TABLE public.merchant_ai_generations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins manage ai generations"
  ON public.merchant_ai_generations FOR ALL TO authenticated
  USING (public.has_role(auth.uid(),'admin'))
  WITH CHECK (public.has_role(auth.uid(),'admin'));

-- updated_at trigger reuse
CREATE TRIGGER trg_merchants_updated_at BEFORE UPDATE ON public.merchants
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER trg_merchant_products_updated_at BEFORE UPDATE ON public.merchant_products
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ============================================================
-- Storage buckets (public read; admin writes via storage RLS)
-- ============================================================
INSERT INTO storage.buckets (id, name, public) VALUES
  ('merchant-logos','merchant-logos', true),
  ('merchant-banners','merchant-banners', true),
  ('merchant-products','merchant-products', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Public read merchant assets"
  ON storage.objects FOR SELECT
  USING (bucket_id IN ('merchant-logos','merchant-banners','merchant-products'));

CREATE POLICY "Admins write merchant assets"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id IN ('merchant-logos','merchant-banners','merchant-products')
    AND public.has_role(auth.uid(),'admin')
  );

CREATE POLICY "Admins update merchant assets"
  ON storage.objects FOR UPDATE TO authenticated
  USING (
    bucket_id IN ('merchant-logos','merchant-banners','merchant-products')
    AND public.has_role(auth.uid(),'admin')
  );

CREATE POLICY "Admins delete merchant assets"
  ON storage.objects FOR DELETE TO authenticated
  USING (
    bucket_id IN ('merchant-logos','merchant-banners','merchant-products')
    AND public.has_role(auth.uid(),'admin')
  );
