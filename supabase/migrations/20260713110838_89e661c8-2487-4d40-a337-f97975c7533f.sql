
-- =====================================================================
-- P0 Driver ID SSOT hardening + safe repair
-- =====================================================================
-- Audit result: 0 duplicates, 0 nulls, 1 malformed legacy code (2520001)
-- generated before service_area.driver_id_prefix was set for Banadir.
-- The generate_driver_code() BEFORE-INSERT trigger is the sole allocator;
-- no client path writes driver_code. We now:
--   1. Repair the malformed code to BAN0001
--   2. Reset the Banadir driver_sa sequence
--   3. Add a case-insensitive UNIQUE index on driver_code
--   4. Add a format CHECK (prefix 2-8 alnum + 4-6 digits)
--   5. Add a trigger blocking any UPDATE to driver_code from non-service_role
-- =====================================================================

-- 1. Repair malformed code (single row, verified by audit)
UPDATE public.drivers
   SET driver_code = 'BAN0001'
 WHERE id = '579ae9b9-065f-4b86-bd6d-84612931fe2d'
   AND driver_code = '2520001';

-- 2. Reset Banadir SA sequence so the next allocation is BAN0002
UPDATE public.id_sequences
   SET current_value = 1, updated_at = now()
 WHERE sequence_type = 'driver_sa'
   AND region_id = '29259edf-80eb-4c08-9089-352b8a305b81';

-- 3. Enforce uniqueness (case-insensitive) on driver_code — the SSOT lock
CREATE UNIQUE INDEX IF NOT EXISTS drivers_driver_code_ci_unique
  ON public.drivers ((UPPER(driver_code)))
  WHERE driver_code IS NOT NULL;

-- 4. Enforce canonical format: 2-8 alnum prefix + 4-6 digits, uppercase
ALTER TABLE public.drivers
  DROP CONSTRAINT IF EXISTS drivers_driver_code_format_chk;
ALTER TABLE public.drivers
  ADD CONSTRAINT drivers_driver_code_format_chk
  CHECK (
    driver_code IS NULL
    OR driver_code ~ '^[A-Z0-9]{2,8}[0-9]{4,6}$'
  ) NOT VALID;
-- Validate against existing rows now that the malformed one is repaired
ALTER TABLE public.drivers
  VALIDATE CONSTRAINT drivers_driver_code_format_chk;

-- 5. Block any non-service_role from mutating driver_code after insert.
--    The trigger allocator runs BEFORE INSERT so this only affects UPDATE.
CREATE OR REPLACE FUNCTION public.protect_driver_code_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.driver_code IS DISTINCT FROM OLD.driver_code THEN
    IF current_setting('request.jwt.claim.role', true) IS DISTINCT FROM 'service_role'
       AND session_user <> 'postgres'
       AND session_user <> 'supabase_admin' THEN
      RAISE EXCEPTION 'driver_code is immutable and can only be changed by service_role'
        USING errcode = '42501';
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
