
-- Add rider_status and deleted_at to customers
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS rider_status TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;

-- Add constraint for valid statuses
ALTER TABLE public.customers
  ADD CONSTRAINT chk_rider_status CHECK (rider_status IN ('active', 'disabled', 'suspended', 'deleted'));

-- Index for filtering
CREATE INDEX IF NOT EXISTS idx_customers_rider_status ON public.customers (rider_status);

-- Trigger: block disable/delete if rider has active trip, auto-set deleted_at
CREATE OR REPLACE FUNCTION public.fn_rider_status_enforce()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- If status is changing to disabled or deleted, check for active trip
  IF NEW.rider_status IN ('disabled', 'deleted') AND OLD.rider_status NOT IN ('disabled', 'deleted') THEN
    IF NEW.active_trip_id IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot disable or delete rider with an active trip (trip_id: %)', NEW.active_trip_id;
    END IF;
  END IF;

  -- Auto-set deleted_at when status changes to deleted
  IF NEW.rider_status = 'deleted' AND OLD.rider_status != 'deleted' THEN
    NEW.deleted_at = now();
  END IF;

  -- Clear deleted_at if restoring from deleted
  IF NEW.rider_status != 'deleted' AND OLD.rider_status = 'deleted' THEN
    NEW.deleted_at = NULL;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER tr_rider_status_enforce
  BEFORE UPDATE ON public.customers
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_rider_status_enforce();
