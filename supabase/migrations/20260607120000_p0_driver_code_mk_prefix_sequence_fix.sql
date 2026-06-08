-- P0: Fix driver_code generation — service-area prefix + 4-digit per-area sequence.
-- Root cause: onboarding inserted drivers without service_area_id, so get_service_area_code()
-- returned UNK and the sentinel id_sequences counter produced UNK004.
-- Format: <SERVICE_AREA_CODE><4-digit sequence> e.g. MK0001, LAH0001

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
  v_sa_key := COALESCE(v_sa_id, '00000000-0000-0000-0000-000000000000'::uuid);

  SELECT driver_code
    INTO v_last_code
  FROM public.drivers
  WHERE driver_code ~ ('^' || v_sa_code || '[0-9]+$')
  ORDER BY (regexp_replace(driver_code, '^' || v_sa_code, '')::int) DESC
  LIMIT 1;

  INSERT INTO public.id_sequences (region_id, sequence_type, current_value)
  VALUES (v_sa_key, 'driver_sa', 1)
  ON CONFLICT (region_id, sequence_type)
  DO UPDATE SET current_value = id_sequences.current_value + 1, updated_at = now()
  RETURNING current_value INTO v_next_val;

  IF v_last_code IS NOT NULL THEN
    v_last_num := (regexp_replace(v_last_code, '^' || v_sa_code, ''))::int;
    IF v_next_val <= v_last_num THEN
      v_next_val := v_last_num + 1;
      UPDATE public.id_sequences
        SET current_value = v_next_val, updated_at = now()
        WHERE region_id = v_sa_key AND sequence_type = 'driver_sa';
    END IF;
  END IF;

  v_candidate := v_sa_code || LPAD(v_next_val::text, 4, '0');

  WHILE EXISTS (SELECT 1 FROM public.drivers WHERE driver_code = v_candidate) AND v_attempts < 50 LOOP
    v_next_val := v_next_val + 1;
    v_candidate := v_sa_code || LPAD(v_next_val::text, 4, '0');
    v_attempts := v_attempts + 1;
    UPDATE public.id_sequences
      SET current_value = v_next_val, updated_at = now()
      WHERE region_id = v_sa_key AND sequence_type = 'driver_sa';
  END LOOP;

  NEW.driver_code := v_candidate;
  RETURN NEW;
END;
$$;

-- Prod one-off: UNK004 (bookings@onecab.net) → MK0001, first driver in Milton Keynes.
DO $$
DECLARE
  v_driver_id uuid := '58b29f86-6cf9-4492-b971-d17d8e0456c7';
  v_mk_sa_id uuid := 'cb58f1bd-8b6f-45b9-ad31-b3140309892c';
BEGIN
  IF EXISTS (SELECT 1 FROM public.drivers WHERE id = v_driver_id AND driver_code = 'UNK004') THEN
    UPDATE public.drivers
      SET service_area_id = v_mk_sa_id,
          driver_code = 'MK0001',
          updated_at = now()
      WHERE id = v_driver_id;

    INSERT INTO public.id_sequences (region_id, sequence_type, current_value)
    VALUES (v_mk_sa_id, 'driver_sa', 1)
    ON CONFLICT (region_id, sequence_type)
    DO UPDATE SET current_value = 1, updated_at = now();
  END IF;
END $$;
