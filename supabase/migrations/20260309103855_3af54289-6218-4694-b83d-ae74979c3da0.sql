
-- =====================================================
-- 1. CUSTOMER DEDUP: Unique constraint on customers.user_id
-- =====================================================
ALTER TABLE public.customers 
  ADD CONSTRAINT customers_user_id_unique UNIQUE (user_id);

-- =====================================================
-- 2. FIND OR CREATE CUSTOMER (prevents duplicates)
-- =====================================================
CREATE OR REPLACE FUNCTION public.find_or_create_customer(
  p_user_id uuid DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_first_name text DEFAULT NULL,
  p_last_name text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_customer_id uuid;
BEGIN
  -- 1. Try by user_id
  IF p_user_id IS NOT NULL THEN
    SELECT id INTO v_customer_id FROM customers WHERE user_id = p_user_id LIMIT 1;
    IF v_customer_id IS NOT NULL THEN
      -- Update name/phone if provided
      UPDATE customers SET
        first_name = COALESCE(NULLIF(p_first_name, ''), first_name),
        last_name = COALESCE(NULLIF(p_last_name, ''), last_name),
        phone = COALESCE(NULLIF(p_phone, ''), phone),
        updated_at = now()
      WHERE id = v_customer_id;
      RETURN v_customer_id;
    END IF;
  END IF;

  -- 2. Try by phone
  IF p_phone IS NOT NULL AND p_phone != '' THEN
    SELECT id INTO v_customer_id FROM customers WHERE phone = p_phone LIMIT 1;
    IF v_customer_id IS NOT NULL THEN
      RETURN v_customer_id;
    END IF;
  END IF;

  -- 3. No match found — create only if user_id provided
  IF p_user_id IS NOT NULL THEN
    INSERT INTO customers (user_id, first_name, last_name, phone)
    VALUES (p_user_id, p_first_name, p_last_name, p_phone)
    ON CONFLICT (user_id) DO UPDATE SET
      first_name = COALESCE(NULLIF(EXCLUDED.first_name, ''), customers.first_name),
      last_name = COALESCE(NULLIF(EXCLUDED.last_name, ''), customers.last_name),
      phone = COALESCE(NULLIF(EXCLUDED.phone, ''), customers.phone),
      updated_at = now()
    RETURNING id INTO v_customer_id;
    RETURN v_customer_id;
  END IF;

  RETURN NULL;
END;
$$;

-- =====================================================
-- 3. SERVICE AREA POLYGON VALIDATION TRIGGER
-- =====================================================
CREATE OR REPLACE FUNCTION public.validate_service_area_boundary()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_boundary jsonb;
  v_length int;
BEGIN
  -- geo_boundary is required
  IF NEW.geo_boundary IS NULL THEN
    RAISE EXCEPTION 'Service area must have a polygon boundary. Draw the boundary on the map before saving.';
  END IF;

  v_boundary := NEW.geo_boundary::jsonb;

  -- Must be an array
  IF jsonb_typeof(v_boundary) != 'array' THEN
    RAISE EXCEPTION 'Service area geo_boundary must be an array of coordinate points.';
  END IF;

  v_length := jsonb_array_length(v_boundary);

  -- Minimum 3 points for a valid polygon
  IF v_length < 3 THEN
    RAISE EXCEPTION 'Service area polygon must have at least 3 coordinate points. Found: %', v_length;
  END IF;

  -- Each point must have lat and lng
  IF NOT (v_boundary->0 ? 'lat') OR NOT (v_boundary->0 ? 'lng') THEN
    RAISE EXCEPTION 'Each polygon point must have "lat" and "lng" properties.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER tr_validate_service_area_boundary
  BEFORE INSERT OR UPDATE ON public.service_areas
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_service_area_boundary();

-- =====================================================
-- 4. VALIDATE TRIP HAS VALID PICKUP SERVICE AREA
-- =====================================================
CREATE OR REPLACE FUNCTION public.validate_trip_service_area()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_sa_id uuid;
BEGIN
  -- Only validate on INSERT when pickup coordinates are present
  IF TG_OP = 'INSERT' AND NEW.pickup_latitude IS NOT NULL AND NEW.pickup_longitude IS NOT NULL THEN
    -- Try to find service area by location
    SELECT id INTO v_sa_id
    FROM service_areas
    WHERE is_active = true
      AND geo_boundary IS NOT NULL
      AND point_in_polygon(NEW.pickup_latitude, NEW.pickup_longitude, geo_boundary)
    LIMIT 1;

    IF v_sa_id IS NULL AND NEW.service_area_id IS NULL THEN
      RAISE EXCEPTION 'Pickup location is not inside any active service area polygon. Please ensure a valid service area exists for this location.';
    END IF;

    -- Auto-set service_area_id if not provided
    IF NEW.service_area_id IS NULL AND v_sa_id IS NOT NULL THEN
      NEW.service_area_id := v_sa_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER tr_validate_trip_service_area
  BEFORE INSERT ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.validate_trip_service_area();
