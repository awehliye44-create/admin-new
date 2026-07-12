
-- 1) Add columns
ALTER TABLE public.service_areas
  ADD COLUMN IF NOT EXISTS trip_id_prefix text,
  ADD COLUMN IF NOT EXISTS driver_id_prefix text;

-- 2) Backfill from existing code
UPDATE public.service_areas
SET trip_id_prefix = COALESCE(NULLIF(UPPER(TRIM(trip_id_prefix)), ''), UPPER(TRIM(code)), 'XX'),
    driver_id_prefix = COALESCE(NULLIF(UPPER(TRIM(driver_id_prefix)), ''), UPPER(TRIM(code)), 'XX');

-- 3) Normalize + validate via trigger (uppercase, trim, no spaces, safe charset)
CREATE OR REPLACE FUNCTION public.service_areas_normalize_prefixes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.code IS NOT NULL THEN
    NEW.code := UPPER(REGEXP_REPLACE(TRIM(NEW.code), '\s+', '', 'g'));
  END IF;
  IF NEW.trip_id_prefix IS NOT NULL THEN
    NEW.trip_id_prefix := UPPER(REGEXP_REPLACE(TRIM(NEW.trip_id_prefix), '\s+', '', 'g'));
  END IF;
  IF NEW.driver_id_prefix IS NOT NULL THEN
    NEW.driver_id_prefix := UPPER(REGEXP_REPLACE(TRIM(NEW.driver_id_prefix), '\s+', '', 'g'));
  END IF;

  IF NEW.trip_id_prefix IS NULL OR NEW.trip_id_prefix !~ '^[A-Z0-9]{2,8}$' THEN
    RAISE EXCEPTION 'trip_id_prefix must match ^[A-Z0-9]{2,8}$ (got %)', NEW.trip_id_prefix;
  END IF;
  IF NEW.driver_id_prefix IS NULL OR NEW.driver_id_prefix !~ '^[A-Z0-9]{2,8}$' THEN
    RAISE EXCEPTION 'driver_id_prefix must match ^[A-Z0-9]{2,8}$ (got %)', NEW.driver_id_prefix;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_service_areas_normalize_prefixes ON public.service_areas;
CREATE TRIGGER trg_service_areas_normalize_prefixes
BEFORE INSERT OR UPDATE ON public.service_areas
FOR EACH ROW EXECUTE FUNCTION public.service_areas_normalize_prefixes();

-- 4) Enforce NOT NULL after backfill
ALTER TABLE public.service_areas
  ALTER COLUMN trip_id_prefix SET NOT NULL,
  ALTER COLUMN driver_id_prefix SET NOT NULL;

-- 5) Case-insensitive uniqueness per prefix
CREATE UNIQUE INDEX IF NOT EXISTS service_areas_trip_id_prefix_uniq
  ON public.service_areas (UPPER(trip_id_prefix));
CREATE UNIQUE INDEX IF NOT EXISTS service_areas_driver_id_prefix_uniq
  ON public.service_areas (UPPER(driver_id_prefix));

-- 6) Update trip code generator to use trip_id_prefix SSOT
CREATE OR REPLACE FUNCTION public.generate_trip_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_sa_id uuid;
  v_sa_code text;
  v_date text;
  v_seq_type text;
  v_seq integer;
  v_code text;
BEGIN
  v_sa_id := NEW.service_area_id;
  IF v_sa_id IS NULL AND NEW.driver_id IS NOT NULL THEN
    SELECT service_area_id INTO v_sa_id FROM public.drivers WHERE id = NEW.driver_id;
  END IF;
  IF v_sa_id IS NULL THEN
    SELECT id INTO v_sa_id FROM public.service_areas WHERE code IS NOT NULL ORDER BY created_at LIMIT 1;
  END IF;

  SELECT COALESCE(NULLIF(UPPER(TRIM(trip_id_prefix)), ''), NULLIF(UPPER(TRIM(code)), ''), 'XX')
    INTO v_sa_code
  FROM public.service_areas WHERE id = v_sa_id;

  v_date := to_char(COALESCE(NEW.created_at, now()), 'YYMMDD');
  v_seq_type := 'trip_daily_' || v_date;

  INSERT INTO public.service_area_sequences (service_area_id, service_area_code, sequence_type, current_value)
  VALUES (v_sa_id, v_sa_code, v_seq_type, 1)
  ON CONFLICT (service_area_id, sequence_type)
  DO UPDATE SET current_value = service_area_sequences.current_value + 1, updated_at = now()
  RETURNING current_value INTO v_seq;

  v_code := v_sa_code || '-' || v_date || '-' || LPAD(v_seq::text, 3, '0');

  NEW.service_area_id    := v_sa_id;
  NEW.service_area_code  := v_sa_code;
  NEW.sequence_no        := v_seq;
  NEW.trip_code          := v_code;
  NEW.trip_number        := v_code;

  RETURN NEW;
END;
$function$;

-- 7) Update service-area code resolver used by driver code trigger to prefer driver_id_prefix
CREATE OR REPLACE FUNCTION public.get_service_area_code(p_service_area_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_prefix text;
  v_code text;
  v_name text;
BEGIN
  IF p_service_area_id IS NULL THEN
    RETURN 'UNK';
  END IF;

  SELECT
    NULLIF(UPPER(TRIM(driver_id_prefix)), ''),
    NULLIF(UPPER(TRIM(code)), ''),
    name
  INTO v_prefix, v_code, v_name
  FROM public.service_areas
  WHERE id = p_service_area_id;

  IF v_prefix IS NOT NULL THEN
    RETURN v_prefix;
  END IF;
  IF v_code IS NOT NULL THEN
    RETURN v_code;
  END IF;
  IF v_name IS NOT NULL THEN
    RETURN UPPER(LEFT(REGEXP_REPLACE(v_name, '[^A-Za-z]', '', 'g'), 2));
  END IF;
  RETURN 'UNK';
END;
$$;
