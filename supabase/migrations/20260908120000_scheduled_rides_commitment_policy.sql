-- Scheduled Rides commitment policy knobs (Admin = policy only).
-- System fallbacks on global_dispatch_settings; optional SA jsonb override;
-- optional location access_allowance_minutes on custom_zones.
-- Disabling scheduled rides must NOT delete these values.

ALTER TABLE public.global_dispatch_settings
  ADD COLUMN IF NOT EXISTS check_in_min_lead_minutes integer NOT NULL DEFAULT 90,
  ADD COLUMN IF NOT EXISTS check_in_grace_minutes integer NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS early_arrival_buffer_minutes integer NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS safety_buffer_minutes integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS start_journey_grace_minutes integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS driver_location_freshness_seconds integer NOT NULL DEFAULT 60,
  ADD COLUMN IF NOT EXISTS driver_response_timeout_minutes integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS not_moving_detection_minutes integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS rescue_search_lead_minutes integer NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS admin_escalation_lead_minutes integer NOT NULL DEFAULT 25,
  ADD COLUMN IF NOT EXISTS scheduled_turnaround_buffer_minutes integer NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS min_gap_between_scheduled_minutes integer NOT NULL DEFAULT 15,
  ADD COLUMN IF NOT EXISTS expected_pickup_waiting_minutes integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS expected_stop_waiting_minutes integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS eta_risk_tolerance_minutes integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS pickup_access_allowance_minutes integer NOT NULL DEFAULT 0;

-- Align new response timeout with legacy locked_driver_response_minutes where present
UPDATE public.global_dispatch_settings
SET driver_response_timeout_minutes = COALESCE(locked_driver_response_minutes, driver_response_timeout_minutes)
WHERE singleton = true;

COMMENT ON COLUMN public.global_dispatch_settings.urgent_dispatch_trigger_minutes_before_pickup IS
  'Fallback only for scheduled bookings with NO pre-confirmed driver. Confirmed drivers use dynamic commitment policy knobs (check-in / leave-by / start journey / risk / rescue), not this fixed pickup-minus trigger.';

COMMENT ON COLUMN public.global_dispatch_settings.check_in_min_lead_minutes IS
  'Policy knob: minimum lead before pickup when check-in may open. Runtime calculates actual check-in from live ETA + workload.';

COMMENT ON COLUMN public.global_dispatch_settings.pickup_access_allowance_minutes IS
  'System default pickup access allowance (airports/stations/venues). Location overrides may add access time without separate workflows.';

-- Optional SA-level commitment overrides (NULL / empty = inherit global)
ALTER TABLE public.dispatch_settings
  ADD COLUMN IF NOT EXISTS scheduled_commitment_policy jsonb;

COMMENT ON COLUMN public.dispatch_settings.scheduled_commitment_policy IS
  'Optional service-area overrides for scheduled commitment policy knobs. NULL or {} inherits global_dispatch_settings. Does not create a separate workflow.';

-- Location-specific access time (any zone type — not airport-only)
ALTER TABLE public.custom_zones
  ADD COLUMN IF NOT EXISTS access_allowance_minutes integer;

COMMENT ON COLUMN public.custom_zones.access_allowance_minutes IS
  'Optional pickup-zone/location access allowance minutes added to scheduled commitment policy. NULL inherits SA/global default. Applies to airports, stations, venues, restricted zones alike.';

-- Non-negative guards (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'gds_commitment_nonneg_check'
  ) THEN
    ALTER TABLE public.global_dispatch_settings
      ADD CONSTRAINT gds_commitment_nonneg_check CHECK (
        check_in_min_lead_minutes >= 0
        AND check_in_grace_minutes >= 0
        AND early_arrival_buffer_minutes >= 0
        AND safety_buffer_minutes >= 0
        AND start_journey_grace_minutes >= 0
        AND driver_location_freshness_seconds >= 0
        AND driver_response_timeout_minutes >= 0
        AND not_moving_detection_minutes >= 0
        AND rescue_search_lead_minutes >= 0
        AND admin_escalation_lead_minutes >= 0
        AND scheduled_turnaround_buffer_minutes >= 0
        AND min_gap_between_scheduled_minutes >= 0
        AND expected_pickup_waiting_minutes >= 0
        AND expected_stop_waiting_minutes >= 0
        AND eta_risk_tolerance_minutes >= 0
        AND pickup_access_allowance_minutes >= 0
      );
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'custom_zones_access_allowance_nonneg'
  ) THEN
    ALTER TABLE public.custom_zones
      ADD CONSTRAINT custom_zones_access_allowance_nonneg CHECK (
        access_allowance_minutes IS NULL OR access_allowance_minutes >= 0
      );
  END IF;
END $$;
