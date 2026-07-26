-- P0 Trip ID + Driver ID SSOT
-- Canonical allocators, fail-closed SA resolution, prefix lock after issuance,
-- sequence reconciliation, missing-ID backfill, immutability.
-- Does NOT change existing valid trip_code / driver_code values.

-- ---------------------------------------------------------------------------
-- 1) Prefix lock flags on service_areas
-- ---------------------------------------------------------------------------
ALTER TABLE public.service_areas
  ADD COLUMN IF NOT EXISTS trip_id_prefix_locked boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS driver_id_prefix_locked boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.service_areas.trip_id_prefix_locked IS
  'True after first trip_code issued for this SA — trip_id_prefix becomes immutable.';
COMMENT ON COLUMN public.service_areas.driver_id_prefix_locked IS
  'True after first driver_code issued for this SA — driver_id_prefix becomes immutable.';

-- Lock any SA that already issued identifiers
UPDATE public.service_areas sa
SET trip_id_prefix_locked = true
WHERE EXISTS (
  SELECT 1 FROM public.trips t
  WHERE t.service_area_id = sa.id
    AND t.trip_code IS NOT NULL
    AND BTRIM(t.trip_code) <> ''
);

UPDATE public.service_areas sa
SET driver_id_prefix_locked = true
WHERE EXISTS (
  SELECT 1 FROM public.drivers d
  WHERE d.service_area_id = sa.id
    AND d.driver_code IS NOT NULL
    AND BTRIM(d.driver_code) <> ''
);

-- ---------------------------------------------------------------------------
-- 2) Exception report for unresolved driver IDs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.driver_id_allocation_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id uuid NOT NULL REFERENCES public.drivers (id) ON DELETE CASCADE,
  reason text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS driver_id_allocation_exceptions_open_uidx
  ON public.driver_id_allocation_exceptions (driver_id)
  WHERE resolved_at IS NULL;

COMMENT ON TABLE public.driver_id_allocation_exceptions IS
  'Drivers that cannot receive a Driver ID until a valid service_area_id + driver_id_prefix exist.';

-- ---------------------------------------------------------------------------
-- 3) Canonical Driver ID allocator
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.allocate_driver_reference(p_service_area_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prefix text;
  v_sa_key uuid;
  v_next_val integer;
  v_last_code text;
  v_last_num integer;
  v_candidate text;
  v_attempts integer := 0;
BEGIN
  IF p_service_area_id IS NULL THEN
    RAISE EXCEPTION 'DRIVER_ID_ALLOCATOR: service_area_id is required'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT NULLIF(UPPER(REGEXP_REPLACE(TRIM(driver_id_prefix), '\s+', '', 'g')), '')
    INTO v_prefix
  FROM public.service_areas
  WHERE id = p_service_area_id
  FOR UPDATE;

  IF v_prefix IS NULL OR v_prefix !~ '^[A-Z0-9]{2,8}$' THEN
    RAISE EXCEPTION
      'DRIVER_ID_ALLOCATOR: service area % has no valid driver_id_prefix — refuse allocation (no fallback)',
      p_service_area_id
      USING ERRCODE = 'check_violation';
  END IF;

  v_sa_key := p_service_area_id;

  -- Lock sequence row first (atomic counter — never COUNT(*)+1 / unlocked MAX+1 alone).
  INSERT INTO public.id_sequences (region_id, sequence_type, current_value)
  VALUES (v_sa_key, 'driver_sa', 0)
  ON CONFLICT (region_id, sequence_type)
  DO UPDATE SET updated_at = now();

  UPDATE public.id_sequences
  SET current_value = current_value + 1,
      updated_at = now()
  WHERE region_id = v_sa_key AND sequence_type = 'driver_sa'
  RETURNING current_value INTO v_next_val;

  -- Reconcile against highest issued suffix for this prefix (never fill gaps).
  SELECT d.driver_code
    INTO v_last_code
  FROM public.drivers d
  WHERE d.driver_code ~ ('^' || v_prefix || '[0-9]+$')
  ORDER BY (regexp_replace(d.driver_code, '^' || v_prefix, '', 'i')::int) DESC
  LIMIT 1;

  IF v_last_code IS NOT NULL THEN
    v_last_num := (regexp_replace(v_last_code, '^' || v_prefix, '', 'i'))::int;
    IF v_next_val <= v_last_num THEN
      v_next_val := v_last_num + 1;
      UPDATE public.id_sequences
        SET current_value = v_next_val, updated_at = now()
        WHERE region_id = v_sa_key AND sequence_type = 'driver_sa';
    END IF;
  END IF;

  -- Format: PREFIX + 4-digit zero-pad (SSOT matching MK0001 / BAN0001 / KAM0001)
  v_candidate := v_prefix || LPAD(v_next_val::text, 4, '0');

  WHILE EXISTS (
    SELECT 1 FROM public.drivers WHERE UPPER(BTRIM(driver_code)) = UPPER(v_candidate)
  ) AND v_attempts < 100 LOOP
    v_next_val := v_next_val + 1;
    v_candidate := v_prefix || LPAD(v_next_val::text, 4, '0');
    v_attempts := v_attempts + 1;
    UPDATE public.id_sequences
      SET current_value = v_next_val, updated_at = now()
      WHERE region_id = v_sa_key AND sequence_type = 'driver_sa';
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM public.drivers WHERE UPPER(BTRIM(driver_code)) = UPPER(v_candidate)
  ) THEN
    RAISE EXCEPTION 'DRIVER_ID_ALLOCATOR: could not allocate unique driver_code for prefix %', v_prefix
      USING ERRCODE = 'unique_violation';
  END IF;

  -- Lock prefix after first issuance
  UPDATE public.service_areas
  SET driver_id_prefix_locked = true
  WHERE id = p_service_area_id
    AND driver_id_prefix_locked IS DISTINCT FROM true;

  RETURN v_candidate;
END;
$$;

COMMENT ON FUNCTION public.allocate_driver_reference(uuid) IS
  'Canonical Driver ID allocator — service_area.driver_id_prefix + atomic sequence. No region/country/first-SA fallback.';

-- ---------------------------------------------------------------------------
-- 4) Canonical Trip ID allocator
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.allocate_trip_reference(p_service_area_id uuid, p_created_at timestamptz DEFAULT now())
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_prefix text;
  v_date text;
  v_seq_type text;
  v_seq integer;
  v_last_num integer;
  v_code text;
  v_attempts integer := 0;
BEGIN
  IF p_service_area_id IS NULL THEN
    RAISE EXCEPTION 'TRIP_ID_ALLOCATOR: service_area_id is required — refuse first-SA / region fallback'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT NULLIF(UPPER(REGEXP_REPLACE(TRIM(trip_id_prefix), '\s+', '', 'g')), '')
    INTO v_prefix
  FROM public.service_areas
  WHERE id = p_service_area_id
  FOR UPDATE;

  IF v_prefix IS NULL OR v_prefix !~ '^[A-Z0-9]{2,8}$' THEN
    RAISE EXCEPTION
      'TRIP_ID_ALLOCATOR: service area % has no valid trip_id_prefix — refuse allocation',
      p_service_area_id
      USING ERRCODE = 'check_violation';
  END IF;

  v_date := to_char(COALESCE(p_created_at, now()), 'YYMMDD');
  v_seq_type := 'trip_daily_' || v_date;

  -- Reconcile max existing daily suffix for this prefix+date (never fill gaps).
  SELECT MAX((regexp_match(UPPER(t.trip_code), '^' || v_prefix || '-' || v_date || '-([0-9]+)$'))[1]::int)
    INTO v_last_num
  FROM public.trips t
  WHERE t.trip_code ~ ('^' || v_prefix || '-' || v_date || '-[0-9]+$');

  INSERT INTO public.service_area_sequences (service_area_id, service_area_code, sequence_type, current_value)
  VALUES (p_service_area_id, v_prefix, v_seq_type, 0)
  ON CONFLICT (service_area_id, sequence_type)
  DO UPDATE SET updated_at = now();

  UPDATE public.service_area_sequences
  SET current_value = current_value + 1,
      service_area_code = v_prefix,
      updated_at = now()
  WHERE service_area_id = p_service_area_id
    AND sequence_type = v_seq_type
  RETURNING current_value INTO v_seq;

  IF v_last_num IS NOT NULL AND v_seq <= v_last_num THEN
    v_seq := v_last_num + 1;
    UPDATE public.service_area_sequences
      SET current_value = v_seq, updated_at = now()
      WHERE service_area_id = p_service_area_id AND sequence_type = v_seq_type;
  END IF;

  v_code := v_prefix || '-' || v_date || '-' || LPAD(v_seq::text, 3, '0');

  WHILE EXISTS (
    SELECT 1 FROM public.trips WHERE UPPER(BTRIM(trip_code)) = UPPER(v_code)
  ) AND v_attempts < 100 LOOP
    v_seq := v_seq + 1;
    v_code := v_prefix || '-' || v_date || '-' || LPAD(v_seq::text, 3, '0');
    v_attempts := v_attempts + 1;
    UPDATE public.service_area_sequences
      SET current_value = v_seq, updated_at = now()
      WHERE service_area_id = p_service_area_id AND sequence_type = v_seq_type;
  END LOOP;

  UPDATE public.service_areas
  SET trip_id_prefix_locked = true
  WHERE id = p_service_area_id
    AND trip_id_prefix_locked IS DISTINCT FROM true;

  RETURN v_code;
END;
$$;

COMMENT ON FUNCTION public.allocate_trip_reference(uuid, timestamptz) IS
  'Canonical Trip ID allocator — service_area.trip_id_prefix-YYMMDD-NNN. No first-SA fallback. Rematch must never call this.';

-- ---------------------------------------------------------------------------
-- 5) Triggers call canonical allocators only
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.generate_driver_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Never overwrite an existing valid Driver ID (signup retry / resume).
  IF NEW.driver_code IS NOT NULL AND BTRIM(NEW.driver_code) <> '' THEN
    NEW.driver_code := UPPER(REGEXP_REPLACE(TRIM(NEW.driver_code), '\s+', '', 'g'));
    RETURN NEW;
  END IF;

  IF NEW.service_area_id IS NULL THEN
    RAISE EXCEPTION
      'DRIVER_ID_REQUIRED_SERVICE_AREA: cannot allocate Driver ID without service_area_id'
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.driver_code := public.allocate_driver_reference(NEW.service_area_id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS generate_driver_code_trigger ON public.drivers;
CREATE TRIGGER generate_driver_code_trigger
  BEFORE INSERT ON public.drivers
  FOR EACH ROW
  EXECUTE FUNCTION public.generate_driver_code();

CREATE OR REPLACE FUNCTION public.generate_trip_code()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_sa_id uuid;
  v_code text;
  v_prefix text;
  v_date text;
  v_seq integer;
BEGIN
  -- Rematch / updates must never regenerate. INSERT-only trigger.
  -- If client supplied a code, still overwrite via allocator for INSERT SSOT
  -- (clients must not invent Trip IDs).

  v_sa_id := NEW.service_area_id;
  IF v_sa_id IS NULL AND NEW.driver_id IS NOT NULL THEN
    SELECT service_area_id INTO v_sa_id FROM public.drivers WHERE id = NEW.driver_id;
  END IF;

  IF v_sa_id IS NULL THEN
    RAISE EXCEPTION
      'TRIP_ID_REQUIRED_SERVICE_AREA: refuse allocation without service_area_id (no first-SA fallback)'
      USING ERRCODE = 'check_violation';
  END IF;

  v_code := public.allocate_trip_reference(v_sa_id, COALESCE(NEW.created_at, now()));
  v_prefix := split_part(v_code, '-', 1);
  v_date := split_part(v_code, '-', 2);
  v_seq := NULLIF(split_part(v_code, '-', 3), '')::int;

  NEW.service_area_id   := v_sa_id;
  NEW.service_area_code := v_prefix;
  NEW.sequence_no       := v_seq;
  NEW.trip_code         := v_code;
  NEW.trip_number       := v_code;
  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6) Immutability: trip_code and driver_code
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.protect_trip_code_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.trip_code IS NOT NULL
     AND BTRIM(OLD.trip_code) <> ''
     AND NEW.trip_code IS DISTINCT FROM OLD.trip_code
  THEN
    -- Allow service_role repair only via explicit setting
    IF current_setting('onecab.allow_trip_code_repair', true) IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION
        'TRIP_ID_IMMUTABLE: trip_code % cannot change (rematch must preserve Trip ID)',
        OLD.trip_code
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_trip_code_immutable ON public.trips;
CREATE TRIGGER trg_protect_trip_code_immutable
  BEFORE UPDATE OF trip_code, trip_number ON public.trips
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_trip_code_immutable();

-- Ensure driver_code immutability still present
CREATE OR REPLACE FUNCTION public.protect_driver_code_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.driver_code IS NOT NULL
     AND BTRIM(OLD.driver_code) <> ''
     AND NEW.driver_code IS DISTINCT FROM OLD.driver_code
  THEN
    IF current_setting('onecab.allow_driver_code_repair', true) IS DISTINCT FROM '1'
       AND current_setting('role', true) IS DISTINCT FROM 'service_role'
    THEN
      -- service_role still blocked unless repair flag set
      IF current_setting('onecab.allow_driver_code_repair', true) IS DISTINCT FROM '1' THEN
        RAISE EXCEPTION
          'DRIVER_ID_IMMUTABLE: driver_code % cannot change',
          OLD.driver_code
          USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_driver_code_immutable ON public.drivers;
CREATE TRIGGER trg_protect_driver_code_immutable
  BEFORE UPDATE OF driver_code ON public.drivers
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_driver_code_immutable();

-- ---------------------------------------------------------------------------
-- 7) Prefix lock enforcement on service_areas
-- ---------------------------------------------------------------------------
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

  IF TG_OP = 'UPDATE' THEN
    IF COALESCE(OLD.trip_id_prefix_locked, false) IS TRUE
       AND NEW.trip_id_prefix IS DISTINCT FROM OLD.trip_id_prefix
    THEN
      RAISE EXCEPTION
        'TRIP_PREFIX_LOCKED: trip_id_prefix is locked after first Trip ID issuance (was %)',
        OLD.trip_id_prefix
        USING ERRCODE = 'check_violation';
    END IF;
    IF COALESCE(OLD.driver_id_prefix_locked, false) IS TRUE
       AND NEW.driver_id_prefix IS DISTINCT FROM OLD.driver_id_prefix
    THEN
      RAISE EXCEPTION
        'DRIVER_PREFIX_LOCKED: driver_id_prefix is locked after first Driver ID issuance (was %)',
        OLD.driver_id_prefix
        USING ERRCODE = 'check_violation';
    END IF;
    -- Preserve lock flags (cannot unlock via ordinary update)
    IF COALESCE(OLD.trip_id_prefix_locked, false) IS TRUE THEN
      NEW.trip_id_prefix_locked := true;
    END IF;
    IF COALESCE(OLD.driver_id_prefix_locked, false) IS TRUE THEN
      NEW.driver_id_prefix_locked := true;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_service_areas_normalize_prefixes ON public.service_areas;
CREATE TRIGGER trg_service_areas_normalize_prefixes
BEFORE INSERT OR UPDATE ON public.service_areas
FOR EACH ROW EXECUTE FUNCTION public.service_areas_normalize_prefixes();

-- ---------------------------------------------------------------------------
-- 8) Uniqueness (partial while nulls remain)
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS drivers_driver_code_ci_unique
  ON public.drivers (UPPER(BTRIM(driver_code)))
  WHERE driver_code IS NOT NULL AND BTRIM(driver_code) <> '';

CREATE UNIQUE INDEX IF NOT EXISTS trips_trip_code_ci_unique
  ON public.trips (UPPER(BTRIM(trip_code)))
  WHERE trip_code IS NOT NULL AND BTRIM(trip_code) <> '';

-- ---------------------------------------------------------------------------
-- 9) Backfill missing Driver IDs (canonical SA only) + duplicate repair
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  v_new_code text;
  v_missing int := 0;
  v_dup_fixed int := 0;
BEGIN
  PERFORM set_config('onecab.allow_driver_code_repair', '1', true);

  -- A/B: missing codes with valid SA → allocate
  FOR r IN
    SELECT d.id, d.service_area_id
    FROM public.drivers d
    WHERE (d.driver_code IS NULL OR BTRIM(d.driver_code) = '')
      AND d.service_area_id IS NOT NULL
    ORDER BY d.created_at ASC, d.id ASC
  LOOP
    BEGIN
      v_new_code := public.allocate_driver_reference(r.service_area_id);
      UPDATE public.drivers SET driver_code = v_new_code, updated_at = now() WHERE id = r.id;
      v_missing := v_missing + 1;
      UPDATE public.driver_id_allocation_exceptions
        SET resolved_at = now()
        WHERE driver_id = r.id AND resolved_at IS NULL;
    EXCEPTION WHEN OTHERS THEN
      INSERT INTO public.driver_id_allocation_exceptions (driver_id, reason, details)
      SELECT r.id, 'ALLOCATION_FAILED', jsonb_build_object('error', SQLERRM, 'service_area_id', r.service_area_id)
      WHERE NOT EXISTS (
        SELECT 1 FROM public.driver_id_allocation_exceptions e
        WHERE e.driver_id = r.id AND e.resolved_at IS NULL
      );
    END;
  END LOOP;

  -- D: missing SA → exception report
  INSERT INTO public.driver_id_allocation_exceptions (driver_id, reason, details)
  SELECT d.id, 'NO_SERVICE_AREA', jsonb_build_object('email', d.email, 'region_id', d.region_id)
  FROM public.drivers d
  WHERE (d.driver_code IS NULL OR BTRIM(d.driver_code) = '')
    AND d.service_area_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM public.driver_id_allocation_exceptions e
      WHERE e.driver_id = d.id AND e.resolved_at IS NULL
    );

  -- C: duplicate driver_codes — keep oldest (created_at ASC, id ASC), reallocate others
  FOR r IN
    SELECT d.id, d.service_area_id, UPPER(BTRIM(d.driver_code)) AS code,
           ROW_NUMBER() OVER (
             PARTITION BY UPPER(BTRIM(d.driver_code))
             ORDER BY d.created_at ASC, d.id ASC
           ) AS rn
    FROM public.drivers d
    WHERE d.driver_code IS NOT NULL AND BTRIM(d.driver_code) <> ''
  LOOP
    IF r.rn > 1 THEN
      IF r.service_area_id IS NULL THEN
        INSERT INTO public.driver_id_allocation_exceptions (driver_id, reason, details)
        SELECT r.id, 'DUPLICATE_NO_SERVICE_AREA', jsonb_build_object('old_code', r.code)
        WHERE NOT EXISTS (
          SELECT 1 FROM public.driver_id_allocation_exceptions e
          WHERE e.driver_id = r.id AND e.resolved_at IS NULL
        );
      ELSE
        v_new_code := public.allocate_driver_reference(r.service_area_id);
        UPDATE public.drivers SET driver_code = v_new_code, updated_at = now() WHERE id = r.id;
        v_dup_fixed := v_dup_fixed + 1;
      END IF;
    END IF;
  END LOOP;

  RAISE NOTICE 'driver_id_backfill missing_filled=% duplicate_repaired=%', v_missing, v_dup_fixed;
END $$;

-- ---------------------------------------------------------------------------
-- 10) Backfill missing Trip IDs (preserve UUID; only null trip_code)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r record;
  v_code text;
  v_filled int := 0;
BEGIN
  PERFORM set_config('onecab.allow_trip_code_repair', '1', true);

  FOR r IN
    SELECT t.id, t.service_area_id, t.created_at
    FROM public.trips t
    WHERE (t.trip_code IS NULL OR BTRIM(t.trip_code) = '')
      AND t.service_area_id IS NOT NULL
    ORDER BY t.created_at ASC, t.id ASC
  LOOP
    v_code := public.allocate_trip_reference(r.service_area_id, r.created_at);
    UPDATE public.trips
    SET trip_code = v_code,
        trip_number = v_code,
        updated_at = now()
    WHERE id = r.id;
    v_filled := v_filled + 1;
  END LOOP;

  RAISE NOTICE 'trip_id_backfill missing_filled=%', v_filled;
END $$;

-- get_service_area_code: fail-closed helper for legacy callers (prefer prefix only)
CREATE OR REPLACE FUNCTION public.get_service_area_code(p_service_area_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_prefix text;
BEGIN
  IF p_service_area_id IS NULL THEN
    RAISE EXCEPTION 'get_service_area_code: service_area_id required'
      USING ERRCODE = 'check_violation';
  END IF;
  SELECT NULLIF(UPPER(REGEXP_REPLACE(TRIM(driver_id_prefix), '\s+', '', 'g')), '')
    INTO v_prefix
  FROM public.service_areas
  WHERE id = p_service_area_id;
  IF v_prefix IS NULL OR v_prefix !~ '^[A-Z0-9]{2,8}$' THEN
    RAISE EXCEPTION 'get_service_area_code: driver_id_prefix missing for %', p_service_area_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN v_prefix;
END;
$$;
