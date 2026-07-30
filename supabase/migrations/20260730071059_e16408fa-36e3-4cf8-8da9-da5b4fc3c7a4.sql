
ALTER TABLE public.driver_special_offers
  ADD COLUMN IF NOT EXISTS scope_type text NOT NULL DEFAULT 'selected_service_areas',
  ADD COLUMN IF NOT EXISTS region_id uuid REFERENCES public.regions(id) ON DELETE RESTRICT;

-- Backfill existing rows from current junction state.
UPDATE public.driver_special_offers o
SET scope_type = CASE
  WHEN EXISTS (SELECT 1 FROM public.driver_special_offer_service_areas j WHERE j.offer_id = o.id)
    THEN 'selected_service_areas'
  ELSE 'global'
END;

ALTER TABLE public.driver_special_offers
  DROP CONSTRAINT IF EXISTS driver_special_offers_scope_type_check;
ALTER TABLE public.driver_special_offers
  ADD CONSTRAINT driver_special_offers_scope_type_check
  CHECK (scope_type IN ('selected_service_areas','entire_region','global'));

CREATE INDEX IF NOT EXISTS idx_dso_scope ON public.driver_special_offers (scope_type, region_id);
CREATE INDEX IF NOT EXISTS idx_dso_sa_area ON public.driver_special_offer_service_areas (service_area_id);

-- Structural scope validation (cannot be bypassed by direct SQL / API writes).
CREATE OR REPLACE FUNCTION public.validate_driver_special_offer_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_area_count integer := 0;
BEGIN
  IF NEW.scope_type = 'global' THEN
    IF NEW.region_id IS NOT NULL THEN
      RAISE EXCEPTION 'GLOBAL_OFFER_CANNOT_HAVE_REGION';
    END IF;
    SELECT count(*) INTO v_area_count
    FROM public.driver_special_offer_service_areas WHERE offer_id = NEW.id;
    IF v_area_count > 0 THEN
      RAISE EXCEPTION 'GLOBAL_OFFER_CANNOT_HAVE_SERVICE_AREAS';
    END IF;

  ELSIF NEW.scope_type = 'entire_region' THEN
    IF NEW.region_id IS NULL THEN
      RAISE EXCEPTION 'ENTIRE_REGION_OFFER_REQUIRES_REGION';
    END IF;

  ELSIF NEW.scope_type = 'selected_service_areas' THEN
    SELECT count(*) INTO v_area_count
    FROM public.driver_special_offer_service_areas WHERE offer_id = NEW.id;
    IF NEW.status = 'published' AND v_area_count = 0 THEN
      RAISE EXCEPTION 'SELECTED_SERVICE_AREAS_OFFER_REQUIRES_AT_LEAST_ONE_SERVICE_AREA';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_driver_special_offer_scope ON public.driver_special_offers;
CREATE CONSTRAINT TRIGGER trg_validate_driver_special_offer_scope
  AFTER INSERT OR UPDATE ON public.driver_special_offers
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION public.validate_driver_special_offer_scope();

-- Junction validation: only active service areas, matching region scope, never for global offers.
CREATE OR REPLACE FUNCTION public.validate_driver_special_offer_area_link()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_scope text;
  v_region uuid;
  v_area_active boolean;
  v_area_region uuid;
BEGIN
  SELECT scope_type, region_id INTO v_scope, v_region
  FROM public.driver_special_offers WHERE id = NEW.offer_id;

  IF v_scope IS NULL THEN
    RAISE EXCEPTION 'OFFER_NOT_FOUND';
  END IF;

  IF v_scope = 'global' THEN
    RAISE EXCEPTION 'GLOBAL_OFFER_CANNOT_HAVE_SERVICE_AREAS';
  END IF;

  SELECT is_active, region_id INTO v_area_active, v_area_region
  FROM public.service_areas WHERE id = NEW.service_area_id;

  IF v_area_active IS NULL THEN
    RAISE EXCEPTION 'SERVICE_AREA_NOT_FOUND';
  END IF;
  IF v_area_active IS NOT TRUE THEN
    RAISE EXCEPTION 'SERVICE_AREA_INACTIVE';
  END IF;
  IF v_region IS NOT NULL AND v_area_region IS DISTINCT FROM v_region THEN
    RAISE EXCEPTION 'SERVICE_AREA_REGION_MISMATCH';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_validate_driver_special_offer_area_link ON public.driver_special_offer_service_areas;
CREATE TRIGGER trg_validate_driver_special_offer_area_link
  BEFORE INSERT OR UPDATE ON public.driver_special_offer_service_areas
  FOR EACH ROW EXECUTE FUNCTION public.validate_driver_special_offer_area_link();
