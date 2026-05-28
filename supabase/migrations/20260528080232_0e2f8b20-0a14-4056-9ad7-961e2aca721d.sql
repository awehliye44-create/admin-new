
-- 1. Drop legacy triggers and functions (no fallback per cleanup policy)
DROP TRIGGER IF EXISTS generate_trip_code_trigger ON public.trips;
DROP TRIGGER IF EXISTS tr_assign_trip_number ON public.trips;
DROP FUNCTION IF EXISTS public.trigger_assign_trip_number() CASCADE;
DROP FUNCTION IF EXISTS public.assign_trip_number(uuid, uuid) CASCADE;
DROP FUNCTION IF EXISTS public.generate_trip_number(uuid) CASCADE;
DROP FUNCTION IF EXISTS public.generate_trip_code() CASCADE;

-- 2. New unified generator: SA-YYMMDD-NNN, sequence resets daily per service area
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
  -- Resolve service area: prefer NEW.service_area_id, else derive from pickup via existing helper if available
  v_sa_id := NEW.service_area_id;
  IF v_sa_id IS NULL AND NEW.driver_id IS NOT NULL THEN
    SELECT service_area_id INTO v_sa_id FROM public.drivers WHERE id = NEW.driver_id;
  END IF;

  IF v_sa_id IS NULL THEN
    -- Fallback: any active service area; trip should normally have one
    SELECT id INTO v_sa_id FROM public.service_areas WHERE code IS NOT NULL ORDER BY created_at LIMIT 1;
  END IF;

  SELECT code INTO v_sa_code FROM public.service_areas WHERE id = v_sa_id;
  IF v_sa_code IS NULL THEN
    v_sa_code := 'XX';
  END IF;

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
  NEW.trip_number        := v_code; -- mirror for backward compatibility

  RETURN NEW;
END;
$function$;

-- ALWAYS overwrite (no WHEN clause) so external apps cannot inject random codes
CREATE TRIGGER generate_trip_code_trigger
BEFORE INSERT ON public.trips
FOR EACH ROW
EXECUTE FUNCTION public.generate_trip_code();

-- 3. Backfill existing trips
-- Clear stale daily sequences (we'll rebuild from actual data)
DELETE FROM public.service_area_sequences WHERE sequence_type LIKE 'trip_daily_%';

WITH ranked AS (
  SELECT
    t.id,
    COALESCE(sa.code, 'XX') AS sa_code,
    sa.id AS sa_id,
    to_char(t.created_at, 'YYMMDD') AS day,
    ROW_NUMBER() OVER (
      PARTITION BY sa.id, to_char(t.created_at, 'YYMMDD')
      ORDER BY t.created_at, t.id
    ) AS seq
  FROM public.trips t
  LEFT JOIN public.service_areas sa ON sa.id = t.service_area_id
)
UPDATE public.trips t
SET trip_code         = r.sa_code || '-' || r.day || '-' || LPAD(r.seq::text, 3, '0'),
    trip_number       = r.sa_code || '-' || r.day || '-' || LPAD(r.seq::text, 3, '0'),
    service_area_code = r.sa_code,
    sequence_no       = r.seq
FROM ranked r
WHERE r.id = t.id;

-- Seed sequence counters with the max used per (service_area, day)
INSERT INTO public.service_area_sequences (service_area_id, service_area_code, sequence_type, current_value)
SELECT
  t.service_area_id,
  COALESCE(sa.code, 'XX'),
  'trip_daily_' || to_char(t.created_at, 'YYMMDD'),
  MAX(t.sequence_no)
FROM public.trips t
LEFT JOIN public.service_areas sa ON sa.id = t.service_area_id
WHERE t.service_area_id IS NOT NULL AND t.sequence_no IS NOT NULL
GROUP BY t.service_area_id, sa.code, to_char(t.created_at, 'YYMMDD')
ON CONFLICT (service_area_id, sequence_type)
DO UPDATE SET current_value = EXCLUDED.current_value, updated_at = now();

-- 4. Uniqueness guarantee
CREATE UNIQUE INDEX IF NOT EXISTS trips_trip_code_unique ON public.trips (trip_code);
CREATE INDEX IF NOT EXISTS trips_service_area_code_idx ON public.trips (service_area_code);
