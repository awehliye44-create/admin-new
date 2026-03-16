
-- Table to persist active stop waiting sessions for Get Paid feature
-- Supports crash recovery, duplicate prevention, and live fare accumulation
CREATE TABLE public.trip_stop_waiting (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  stop_id UUID NOT NULL REFERENCES public.trip_stops(id) ON DELETE CASCADE,
  driver_id UUID NOT NULL REFERENCES public.drivers(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at TIMESTAMPTZ,
  grace_period_seconds INTEGER NOT NULL DEFAULT 0,
  charge_interval_seconds INTEGER NOT NULL DEFAULT 10,
  rate_pence_per_minute INTEGER NOT NULL DEFAULT 0,
  total_waiting_seconds INTEGER NOT NULL DEFAULT 0,
  total_charge_pence INTEGER NOT NULL DEFAULT 0,
  last_tick_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT unique_active_stop_waiting UNIQUE (trip_id, stop_id, status) 
);

-- Partial unique index: only one active waiting session per trip at a time
CREATE UNIQUE INDEX idx_one_active_waiting_per_trip 
  ON public.trip_stop_waiting (trip_id) 
  WHERE status = 'active';

-- Index for driver lookups (restore on reconnect)
CREATE INDEX idx_trip_stop_waiting_driver_active 
  ON public.trip_stop_waiting (driver_id) 
  WHERE status = 'active';

-- RLS
ALTER TABLE public.trip_stop_waiting ENABLE ROW LEVEL SECURITY;

-- Admins can read all
CREATE POLICY "Admins can manage stop waiting"
  ON public.trip_stop_waiting
  FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'));

-- Drivers can read their own
CREATE POLICY "Drivers can read own stop waiting"
  ON public.trip_stop_waiting
  FOR SELECT
  TO authenticated
  USING (driver_id = public.current_driver_id());

-- Trigger for updated_at
CREATE TRIGGER update_trip_stop_waiting_updated_at
  BEFORE UPDATE ON public.trip_stop_waiting
  FOR EACH ROW
  EXECUTE FUNCTION public.update_updated_at_column();

-- RPC: Start stop waiting (with duplicate prevention)
CREATE OR REPLACE FUNCTION public.start_stop_waiting(
  p_trip_id UUID,
  p_stop_id UUID,
  p_driver_id UUID,
  p_grace_period_seconds INTEGER DEFAULT 0,
  p_charge_interval_seconds INTEGER DEFAULT 10,
  p_rate_pence_per_minute INTEGER DEFAULT 0
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_existing_id UUID;
  v_new_id UUID;
BEGIN
  -- Check for existing active session on this trip
  SELECT id INTO v_existing_id
  FROM trip_stop_waiting
  WHERE trip_id = p_trip_id AND status = 'active';
  
  IF v_existing_id IS NOT NULL THEN
    RAISE EXCEPTION 'Active waiting session already exists for this trip';
  END IF;

  INSERT INTO trip_stop_waiting (
    trip_id, stop_id, driver_id,
    grace_period_seconds, charge_interval_seconds, rate_pence_per_minute
  ) VALUES (
    p_trip_id, p_stop_id, p_driver_id,
    p_grace_period_seconds, p_charge_interval_seconds, p_rate_pence_per_minute
  )
  RETURNING id INTO v_new_id;

  RETURN v_new_id;
END;
$$;

-- RPC: Tick waiting (accumulate time and charge)
CREATE OR REPLACE FUNCTION public.tick_stop_waiting(
  p_waiting_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_record trip_stop_waiting;
  v_elapsed_since_last INTEGER;
  v_total_seconds INTEGER;
  v_billable_seconds INTEGER;
  v_charge_pence INTEGER;
BEGIN
  SELECT * INTO v_record
  FROM trip_stop_waiting
  WHERE id = p_waiting_id AND status = 'active'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'NOT_FOUND');
  END IF;

  v_elapsed_since_last := EXTRACT(EPOCH FROM (now() - v_record.last_tick_at))::INTEGER;
  v_total_seconds := v_record.total_waiting_seconds + v_elapsed_since_last;
  
  -- Calculate billable seconds (after grace period)
  v_billable_seconds := GREATEST(0, v_total_seconds - v_record.grace_period_seconds);
  
  -- Calculate total charge: (billable_seconds / 60) * rate_pence_per_minute
  v_charge_pence := ROUND((v_billable_seconds::NUMERIC / 60.0) * v_record.rate_pence_per_minute);

  UPDATE trip_stop_waiting
  SET total_waiting_seconds = v_total_seconds,
      total_charge_pence = v_charge_pence,
      last_tick_at = now()
  WHERE id = p_waiting_id;

  RETURN jsonb_build_object(
    'success', true,
    'total_waiting_seconds', v_total_seconds,
    'billable_seconds', v_billable_seconds,
    'total_charge_pence', v_charge_pence,
    'rate_pence_per_minute', v_record.rate_pence_per_minute
  );
END;
$$;

-- RPC: Stop waiting and finalize charge
CREATE OR REPLACE FUNCTION public.stop_stop_waiting(
  p_waiting_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_record trip_stop_waiting;
  v_final_seconds INTEGER;
  v_billable_seconds INTEGER;
  v_final_charge INTEGER;
BEGIN
  SELECT * INTO v_record
  FROM trip_stop_waiting
  WHERE id = p_waiting_id AND status = 'active'
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', false, 'error', 'NOT_FOUND');
  END IF;

  v_final_seconds := v_record.total_waiting_seconds + EXTRACT(EPOCH FROM (now() - v_record.last_tick_at))::INTEGER;
  v_billable_seconds := GREATEST(0, v_final_seconds - v_record.grace_period_seconds);
  v_final_charge := ROUND((v_billable_seconds::NUMERIC / 60.0) * v_record.rate_pence_per_minute);

  UPDATE trip_stop_waiting
  SET status = 'completed',
      ended_at = now(),
      total_waiting_seconds = v_final_seconds,
      total_charge_pence = v_final_charge,
      last_tick_at = now()
  WHERE id = p_waiting_id;

  -- Update the trip stop with waiting charge
  UPDATE trip_stops
  SET waiting_charge_pence = COALESCE(waiting_charge_pence, 0) + v_final_charge,
      waiting_seconds = COALESCE(waiting_seconds, 0) + v_final_seconds,
      updated_at = now()
  WHERE id = v_record.stop_id;

  RETURN jsonb_build_object(
    'success', true,
    'total_waiting_seconds', v_final_seconds,
    'billable_seconds', v_billable_seconds,
    'total_charge_pence', v_final_charge
  );
END;
$$;

-- RPC: Get active waiting session for a driver (for restore on reconnect)
CREATE OR REPLACE FUNCTION public.get_active_stop_waiting(
  p_driver_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_record trip_stop_waiting;
BEGIN
  SELECT * INTO v_record
  FROM trip_stop_waiting
  WHERE driver_id = p_driver_id AND status = 'active'
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('active', false);
  END IF;

  RETURN jsonb_build_object(
    'active', true,
    'waiting_id', v_record.id,
    'trip_id', v_record.trip_id,
    'stop_id', v_record.stop_id,
    'started_at', v_record.started_at,
    'total_waiting_seconds', v_record.total_waiting_seconds,
    'total_charge_pence', v_record.total_charge_pence,
    'rate_pence_per_minute', v_record.rate_pence_per_minute,
    'grace_period_seconds', v_record.grace_period_seconds,
    'charge_interval_seconds', v_record.charge_interval_seconds,
    'last_tick_at', v_record.last_tick_at
  );
END;
$$;
