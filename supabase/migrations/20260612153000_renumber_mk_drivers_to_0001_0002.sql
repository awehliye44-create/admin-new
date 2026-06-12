-- Renumber the two live Milton Keynes drivers to MK0001 / MK0002.
-- MK0001 and MK0002 were consumed by deleted test signups; only MK0003/MK0004 remained.

DO $$
DECLARE
  v_mk_sa_id uuid := 'cb58f1bd-8b6f-45b9-ad31-b3140309892c';
  v_ahmed_id uuid := '5ed232c3-8bb5-4085-95d6-73e48e6c5e28'; -- bookings@onecab.net
  v_asiya_id uuid := 'cd8bae4c-3827-4b90-98c6-10be70eb0e52'; -- abdi17fitah@gmail.com
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.drivers
    WHERE id IN (v_ahmed_id, v_asiya_id)
      AND driver_code IN ('MK0003', 'MK0004')
  ) THEN
    RAISE NOTICE 'Driver renumber skipped — codes already updated or drivers missing';
    RETURN;
  END IF;

  -- Clear codes first to avoid UNIQUE collisions during swap.
  UPDATE public.drivers SET driver_code = NULL, updated_at = now()
  WHERE id IN (v_ahmed_id, v_asiya_id);

  -- Ahmed Osman (primary ops account) → MK0001; Asiya → MK0002 (created first).
  UPDATE public.drivers
    SET driver_code = 'MK0001', updated_at = now()
  WHERE id = v_ahmed_id;

  UPDATE public.drivers
    SET driver_code = 'MK0002', updated_at = now()
  WHERE id = v_asiya_id;

  INSERT INTO public.id_sequences (region_id, sequence_type, current_value)
  VALUES (v_mk_sa_id, 'driver_sa', 2)
  ON CONFLICT (region_id, sequence_type)
  DO UPDATE SET current_value = 2, updated_at = now();

  UPDATE public.invoices
    SET driver_display_code = CASE driver_id
      WHEN v_ahmed_id THEN 'MK0001'
      WHEN v_asiya_id THEN 'MK0002'
      ELSE driver_display_code
    END
  WHERE driver_id IN (v_ahmed_id, v_asiya_id);
END $$;
