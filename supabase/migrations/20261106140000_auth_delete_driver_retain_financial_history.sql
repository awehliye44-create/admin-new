-- Unblock Auth/driver delete without erasing financial history.
--
-- Root cause: auth.users → drivers CASCADE hard-deletes the driver row, but
-- commission wallet / payout / settlement tables reference drivers.id with
-- NOT NULL + NO ACTION. That aborts Auth delete for any driver with finance history.
-- Separately, dispatch_wave_snapshot ON DELETE SET NULL can collide with
-- unique (trip_id, dispatch_round, stage) when nulling driver_id.
--
-- Fix: detach Auth from drivers (SET NULL) and soft-delete/anonymise the row.
-- Financial ledger rows keep their driver_id. Live GPS snapshots CASCADE away.

BEGIN;

-- 1) Auth delete must not hard-delete drivers that finance history still needs.
ALTER TABLE public.drivers
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE public.drivers
  DROP CONSTRAINT IF EXISTS drivers_user_id_fkey;

ALTER TABLE public.drivers
  ADD CONSTRAINT drivers_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES auth.users (id) ON DELETE SET NULL;

-- 2) Ephemeral GPS: safe to drop with the driver if a hard delete ever happens.
ALTER TABLE public.trip_driver_live_location
  DROP CONSTRAINT IF EXISTS trip_driver_live_location_driver_id_fkey;

ALTER TABLE public.trip_driver_live_location
  ADD CONSTRAINT trip_driver_live_location_driver_id_fkey
  FOREIGN KEY (driver_id) REFERENCES public.drivers (id) ON DELETE CASCADE;

-- 3) Avoid unique collisions when nulling wave snapshot driver_id.
ALTER TABLE public.dispatch_wave_snapshot
  DROP CONSTRAINT IF EXISTS dispatch_wave_snapshot_driver_id_fkey;

ALTER TABLE public.dispatch_wave_snapshot
  ADD CONSTRAINT dispatch_wave_snapshot_driver_id_fkey
  FOREIGN KEY (driver_id) REFERENCES public.drivers (id) ON DELETE CASCADE;

-- 4) Nullable trip pointer — SET NULL is correct.
ALTER TABLE public.trips
  DROP CONSTRAINT IF EXISTS trips_cash_collected_by_driver_id_fkey;

ALTER TABLE public.trips
  ADD CONSTRAINT trips_cash_collected_by_driver_id_fkey
  FOREIGN KEY (cash_collected_by_driver_id) REFERENCES public.drivers (id) ON DELETE SET NULL;

-- 5) When Auth detach nulls user_id, soft-delete + scrub PII so email/phone
--    can be reused on a fresh signup (partial unique indexes require deleted_at).
CREATE OR REPLACE FUNCTION public.drivers_on_auth_detach()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.user_id IS NULL
     AND OLD.user_id IS NOT NULL
  THEN
    NEW.deleted_at := COALESCE(NEW.deleted_at, now());
    NEW.driver_status := 'deleted';
    NEW.is_online := false;
    NEW.first_name := 'Deleted';
    NEW.last_name := 'Driver';
    NEW.email := 'deleted+' || OLD.id::text || '@onecab.invalid';
    NEW.phone := 'deleted:' || OLD.id::text;
    NEW.profile_photo_url := NULL;
    NEW.residential_address := NULL;
    NEW.postcode := NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_drivers_on_auth_detach ON public.drivers;
CREATE TRIGGER trg_drivers_on_auth_detach
  BEFORE UPDATE OF user_id ON public.drivers
  FOR EACH ROW
  EXECUTE FUNCTION public.drivers_on_auth_detach();

COMMENT ON FUNCTION public.drivers_on_auth_detach() IS
  'On Auth detach (user_id SET NULL), soft-delete and anonymise driver so finance FKs remain and email/phone can be re-registered.';

COMMIT;
