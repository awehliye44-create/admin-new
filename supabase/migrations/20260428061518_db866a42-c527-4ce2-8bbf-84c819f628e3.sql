-- ============================================================
-- Driver code generation: switch from REGION code to SERVICE AREA code
-- Format: <SERVICE_AREA_CODE><3-digit zero-padded sequence>
-- Examples: MK001, MK002, LAH001
-- We reuse id_sequences (region_id, sequence_type) unique constraint
-- by storing the SERVICE AREA id in the region_id column when sequence_type = 'driver_sa'.
-- For drivers with no service area we use the all-zero UUID as a sentinel.
-- ============================================================

-- 1) Helper: resolve a service area's short code (UPPER, no spaces). Falls back to 'UNK'.
CREATE OR REPLACE FUNCTION public.get_service_area_code(p_service_area_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_code text;
  v_name text;
BEGIN
  IF p_service_area_id IS NULL THEN
    RETURN 'UNK';
  END IF;

  SELECT NULLIF(UPPER(TRIM(code)), ''), name
    INTO v_code, v_name
  FROM public.service_areas
  WHERE id = p_service_area_id;

  IF v_code IS NOT NULL THEN
    RETURN v_code;
  END IF;

  IF v_name IS NOT NULL THEN
    RETURN UPPER(LEFT(REGEXP_REPLACE(v_name, '[^A-Za-z]', '', 'g'), 2));
  END IF;

  RETURN 'UNK';
END;
$$;

-- 2) Replace generate_driver_code() to use service area code and prevent duplicates
CREATE OR REPLACE FUNCTION public.generate_driver_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sa_id uuid;
  v_sa_key uuid;
  v_sa_code text;
  v_next_val integer;
  v_last_code text;
  v_last_num integer;
  v_candidate text;
  v_attempts integer := 0;
BEGIN
  v_sa_id := NEW.service_area_id;
  v_sa_code := public.get_service_area_code(v_sa_id);
  -- Sentinel UUID for "no service area" so the existing (region_id, sequence_type) unique constraint works
  v_sa_key := COALESCE(v_sa_id, '00000000-0000-0000-0000-000000000000'::uuid);

  -- Highest existing numeric suffix already used for this service-area code
  SELECT driver_code
    INTO v_last_code
  FROM public.drivers
  WHERE driver_code ~ ('^' || v_sa_code || '[0-9]+$')
  ORDER BY (regexp_replace(driver_code, '^' || v_sa_code, '')::int) DESC
  LIMIT 1;

  RAISE NOTICE '[generate_driver_code] service_area_id=% sa_code=% last_existing_code=%',
    v_sa_id, v_sa_code, COALESCE(v_last_code, '(none)');

  -- Upsert sequence row keyed by (service_area_uuid_in_region_id_column, 'driver_sa')
  INSERT INTO public.id_sequences (region_id, sequence_type, current_value)
  VALUES (v_sa_key, 'driver_sa', 1)
  ON CONFLICT (region_id, sequence_type)
  DO UPDATE SET current_value = id_sequences.current_value + 1, updated_at = now()
  RETURNING current_value INTO v_next_val;

  -- Reconcile against actual highest existing suffix
  IF v_last_code IS NOT NULL THEN
    v_last_num := (regexp_replace(v_last_code, '^' || v_sa_code, ''))::int;
    IF v_next_val <= v_last_num THEN
      v_next_val := v_last_num + 1;
      UPDATE public.id_sequences
        SET current_value = v_next_val, updated_at = now()
        WHERE region_id = v_sa_key AND sequence_type = 'driver_sa';
    END IF;
  END IF;

  v_candidate := v_sa_code || LPAD(v_next_val::text, 3, '0');

  -- Defensive: avoid duplicates
  WHILE EXISTS (SELECT 1 FROM public.drivers WHERE driver_code = v_candidate) AND v_attempts < 50 LOOP
    v_next_val := v_next_val + 1;
    v_candidate := v_sa_code || LPAD(v_next_val::text, 3, '0');
    v_attempts := v_attempts + 1;
    UPDATE public.id_sequences
      SET current_value = v_next_val, updated_at = now()
      WHERE region_id = v_sa_key AND sequence_type = 'driver_sa';
  END LOOP;

  NEW.driver_code := v_candidate;

  RAISE NOTICE '[generate_driver_code] FINAL driver_code=% (sa_code=%, seq=%)',
    NEW.driver_code, v_sa_code, v_next_val;

  RETURN NEW;
END;
$$;

-- 3) Recreate trigger (BEFORE INSERT, only when driver_code is null)
DROP TRIGGER IF EXISTS generate_driver_code_trigger ON public.drivers;
CREATE TRIGGER generate_driver_code_trigger
  BEFORE INSERT ON public.drivers
  FOR EACH ROW
  WHEN (NEW.driver_code IS NULL)
  EXECUTE FUNCTION public.generate_driver_code();

-- 4) Backfill: renumber every existing driver by current service_area_id (created_at order).
DO $$
DECLARE
  r RECORD;
  v_sa_code text;
  v_sa_key uuid;
  v_seq integer;
  v_new_code text;
BEGIN
  -- Reset existing driver_sa sequences before renumber
  DELETE FROM public.id_sequences WHERE sequence_type = 'driver_sa';

  -- Two passes: NULL the codes first to avoid UNIQUE collisions during renumber
  UPDATE public.drivers SET driver_code = NULL;

  FOR r IN
    SELECT id, service_area_id, region_id
    FROM public.drivers
    ORDER BY created_at ASC
  LOOP
    v_sa_code := public.get_service_area_code(r.service_area_id);
    v_sa_key := COALESCE(r.service_area_id, '00000000-0000-0000-0000-000000000000'::uuid);

    INSERT INTO public.id_sequences (region_id, sequence_type, current_value)
    VALUES (v_sa_key, 'driver_sa', 1)
    ON CONFLICT (region_id, sequence_type)
    DO UPDATE SET current_value = id_sequences.current_value + 1, updated_at = now()
    RETURNING current_value INTO v_seq;

    v_new_code := v_sa_code || LPAD(v_seq::text, 3, '0');

    UPDATE public.drivers SET driver_code = v_new_code WHERE id = r.id;

    RAISE NOTICE '[backfill] driver=% sa_code=% new_code=%', r.id, v_sa_code, v_new_code;
  END LOOP;
END $$;