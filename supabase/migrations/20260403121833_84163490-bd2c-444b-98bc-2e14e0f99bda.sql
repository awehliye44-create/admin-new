
-- 1. Create enum
CREATE TYPE public.driver_status AS ENUM ('active', 'disabled', 'deleted');

-- 2. Add columns
ALTER TABLE public.drivers
  ADD COLUMN driver_status public.driver_status NOT NULL DEFAULT 'active',
  ADD COLUMN deleted_at timestamptz;

-- 3. Trigger: force offline when disabled/deleted
CREATE OR REPLACE FUNCTION public.tr_driver_status_enforce()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Force offline when not active
  IF NEW.driver_status != 'active' AND OLD.driver_status = 'active' THEN
    NEW.is_online := false;
  END IF;

  -- Set deleted_at timestamp
  IF NEW.driver_status = 'deleted' AND OLD.driver_status != 'deleted' THEN
    NEW.deleted_at := now();
  END IF;

  -- Clear deleted_at if restored
  IF NEW.driver_status != 'deleted' AND OLD.driver_status = 'deleted' THEN
    NEW.deleted_at := NULL;
  END IF;

  -- Block disable/delete if driver has active trip
  IF NEW.driver_status IN ('disabled', 'deleted') AND OLD.driver_status = 'active' THEN
    IF NEW.current_trip_id IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot disable or delete a driver with an active trip (trip_id: %)', NEW.current_trip_id;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER tr_driver_status_enforce
  BEFORE UPDATE ON public.drivers
  FOR EACH ROW
  EXECUTE FUNCTION public.tr_driver_status_enforce();

-- 4. Prevent going online if not active
CREATE OR REPLACE FUNCTION public.tr_block_online_if_not_active()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.is_online = true AND NEW.driver_status != 'active' THEN
    RAISE EXCEPTION 'Driver cannot go online: account status is %', NEW.driver_status;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER tr_block_online_if_not_active
  BEFORE UPDATE ON public.drivers
  FOR EACH ROW
  WHEN (NEW.is_online = true AND OLD.is_online = false)
  EXECUTE FUNCTION public.tr_block_online_if_not_active();

-- 5. Recreate dispatchable_drivers view to include driver_status check
CREATE OR REPLACE VIEW public.dispatchable_drivers AS
SELECT
  d.id AS driver_id,
  d.first_name,
  d.last_name,
  d.rating,
  d.current_trip_id,
  dp.status,
  dp.lat,
  dp.lng,
  dp.heading,
  dp.speed,
  dp.last_heartbeat_at,
  dp.last_location_at,
  dp.app_state,
  dp.platform,
  dp.push_token,
  EXTRACT(epoch FROM now() - dp.last_heartbeat_at) AS heartbeat_age_seconds
FROM drivers d
JOIN driver_presence dp ON d.id = dp.driver_id
WHERE d.approval_status = 'approved'
  AND d.driver_status = 'active'
  AND d.documents_approved = true
  AND d.current_trip_id IS NULL
  AND dp.status = 'online'
  AND dp.last_heartbeat_at > (now() - interval '1 minute')
  AND dp.push_token IS NOT NULL
  AND dp.lat IS NOT NULL
  AND dp.lng IS NOT NULL;
