-- =========================
-- HELP CENTRE
-- =========================
CREATE TABLE public.help_centre_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audience text NOT NULL CHECK (audience IN ('customer','driver')),
  title text NOT NULL,
  description text,
  icon_key text,
  display_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.help_centre_articles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  audience text NOT NULL CHECK (audience IN ('customer','driver')),
  category_id uuid NOT NULL REFERENCES public.help_centre_categories(id) ON DELETE RESTRICT,
  title text NOT NULL,
  slug text NOT NULL,
  summary text,
  body text NOT NULL DEFAULT '',
  cover_image_path text,
  display_order integer NOT NULL DEFAULT 0,
  is_featured boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  is_active boolean NOT NULL DEFAULT true,
  published_at timestamptz,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX help_centre_articles_audience_slug_key
  ON public.help_centre_articles (audience, slug);
CREATE INDEX help_centre_articles_audience_status_idx
  ON public.help_centre_articles (audience, status, is_active, display_order);
CREATE INDEX help_centre_articles_category_idx
  ON public.help_centre_articles (category_id);
CREATE INDEX help_centre_articles_search_idx
  ON public.help_centre_articles USING gin (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(summary,'')));
CREATE INDEX help_centre_categories_audience_idx
  ON public.help_centre_categories (audience, is_active, display_order);

-- audience must match category audience
CREATE OR REPLACE FUNCTION public.enforce_help_article_audience()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_cat_audience text;
BEGIN
  SELECT audience INTO v_cat_audience FROM public.help_centre_categories WHERE id = NEW.category_id;
  IF v_cat_audience IS NULL THEN
    RAISE EXCEPTION 'HELP_CATEGORY_NOT_FOUND';
  END IF;
  IF v_cat_audience <> NEW.audience THEN
    RAISE EXCEPTION 'HELP_AUDIENCE_MISMATCH: article audience % does not match category audience %', NEW.audience, v_cat_audience;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_help_article_audience
BEFORE INSERT OR UPDATE ON public.help_centre_articles
FOR EACH ROW EXECUTE FUNCTION public.enforce_help_article_audience();

CREATE OR REPLACE FUNCTION public.touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_help_categories_touch
BEFORE UPDATE ON public.help_centre_categories
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

GRANT SELECT ON public.help_centre_categories TO authenticated;
GRANT INSERT, UPDATE, DELETE ON public.help_centre_categories TO authenticated;
GRANT ALL ON public.help_centre_categories TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.help_centre_articles TO authenticated;
GRANT ALL ON public.help_centre_articles TO service_role;

ALTER TABLE public.help_centre_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.help_centre_articles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage help categories"
  ON public.help_centre_categories FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE POLICY "Authenticated read active help categories"
  ON public.help_centre_categories FOR SELECT TO authenticated
  USING (is_active = true);

CREATE POLICY "Admins manage help articles"
  ON public.help_centre_articles FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE POLICY "Authenticated read published help articles"
  ON public.help_centre_articles FOR SELECT TO authenticated
  USING (
    status = 'published'
    AND is_active = true
    AND (published_at IS NULL OR published_at <= now())
    AND EXISTS (
      SELECT 1 FROM public.help_centre_categories c
      WHERE c.id = help_centre_articles.category_id
        AND c.is_active = true
        AND c.audience = help_centre_articles.audience
    )
  );

-- =========================
-- DRIVER SPECIAL OFFERS
-- =========================
CREATE TABLE public.driver_special_offer_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  badge_label text,
  display_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.driver_special_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid REFERENCES public.driver_special_offer_categories(id) ON DELETE SET NULL,
  title text NOT NULL,
  partner_name text,
  short_description text NOT NULL,
  full_details text,
  badge_label text,
  image_path text,
  website_url text,
  phone_number text,
  email_address text,
  promo_code text,
  internal_route text,
  website_button_label text,
  phone_button_label text,
  email_button_label text,
  banner_headline text,
  banner_button_label text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  is_active boolean NOT NULL DEFAULT true,
  is_featured boolean NOT NULL DEFAULT false,
  show_in_home_banner boolean NOT NULL DEFAULT false,
  show_in_offer_list boolean NOT NULL DEFAULT true,
  starts_at timestamptz,
  ends_at timestamptz,
  minimum_completed_trips integer,
  new_drivers_only boolean NOT NULL DEFAULT false,
  eligible_driver_tiers text[],
  display_order integer NOT NULL DEFAULT 0,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT driver_special_offers_dates_chk CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at >= starts_at),
  CONSTRAINT driver_special_offers_website_https_chk CHECK (website_url IS NULL OR website_url ~* '^https://')
);

CREATE TABLE public.driver_special_offer_service_areas (
  offer_id uuid NOT NULL REFERENCES public.driver_special_offers(id) ON DELETE CASCADE,
  service_area_id uuid NOT NULL,
  PRIMARY KEY (offer_id, service_area_id)
);

CREATE INDEX driver_special_offers_visibility_idx
  ON public.driver_special_offers (status, is_active, show_in_offer_list, display_order);
CREATE INDEX driver_special_offers_banner_idx
  ON public.driver_special_offers (status, is_active, show_in_home_banner, display_order);
CREATE INDEX driver_special_offers_category_idx
  ON public.driver_special_offers (category_id);
CREATE INDEX driver_special_offer_service_areas_area_idx
  ON public.driver_special_offer_service_areas (service_area_id);

CREATE TRIGGER trg_dso_touch
BEFORE UPDATE ON public.driver_special_offers
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

CREATE TRIGGER trg_dso_cat_touch
BEFORE UPDATE ON public.driver_special_offer_categories
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

GRANT SELECT, INSERT, UPDATE, DELETE ON public.driver_special_offer_categories TO authenticated;
GRANT ALL ON public.driver_special_offer_categories TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.driver_special_offers TO authenticated;
GRANT ALL ON public.driver_special_offers TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.driver_special_offer_service_areas TO authenticated;
GRANT ALL ON public.driver_special_offer_service_areas TO service_role;

ALTER TABLE public.driver_special_offer_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_special_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.driver_special_offer_service_areas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins manage offer categories"
  ON public.driver_special_offer_categories FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE POLICY "Drivers read active offer categories"
  ON public.driver_special_offer_categories FOR SELECT TO authenticated
  USING (is_active = true AND EXISTS (SELECT 1 FROM public.drivers d WHERE d.user_id = auth.uid()));

CREATE POLICY "Admins manage special offers"
  ON public.driver_special_offers FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE POLICY "Drivers read live special offers"
  ON public.driver_special_offers FOR SELECT TO authenticated
  USING (
    status = 'published'
    AND is_active = true
    AND (starts_at IS NULL OR starts_at <= now())
    AND (ends_at IS NULL OR ends_at > now())
    AND EXISTS (SELECT 1 FROM public.drivers d WHERE d.user_id = auth.uid())
  );

CREATE POLICY "Admins manage offer service areas"
  ON public.driver_special_offer_service_areas FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));

CREATE POLICY "Drivers read offer service areas"
  ON public.driver_special_offer_service_areas FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.drivers d WHERE d.user_id = auth.uid()));