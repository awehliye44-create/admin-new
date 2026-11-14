-- Customer Live Trip Lock Screen — presentation-only projection + ActivityKit tokens.
-- NOT applied in this change set (migration application not approved).
-- Presentation layer only: does not mutate trip lifecycle, dispatch, fare, or payment.

CREATE TABLE IF NOT EXISTS public.customer_live_trip_projections (
  trip_id uuid PRIMARY KEY REFERENCES public.trips(id) ON DELETE CASCADE,
  customer_user_id uuid NOT NULL,
  customer_id uuid NULL,
  eligible boolean NOT NULL DEFAULT false,
  terminal boolean NOT NULL DEFAULT false,
  lifecycle_stage text NOT NULL DEFAULT 'idle',
  assignment_generation bigint NOT NULL DEFAULT 0,
  presentation_version bigint NOT NULL DEFAULT 0,
  assigned_driver_id uuid NULL,
  driver_first_name text NULL,
  driver_photo_url text NULL,
  driver_rating numeric NULL,
  driver_rating_count integer NULL,
  vehicle_make text NULL,
  vehicle_model text NULL,
  vehicle_colour text NULL,
  vehicle_registration text NULL,
  vehicle_photo_url text NULL,
  eta_minutes integer NULL,
  status_title text NOT NULL DEFAULT 'Active trip',
  status_description text NOT NULL DEFAULT '',
  progress_step_index integer NOT NULL DEFAULT 0,
  content_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  stale_at timestamptz NULL,
  last_published_at timestamptz NULL
);

CREATE INDEX IF NOT EXISTS customer_live_trip_projections_customer_user_idx
  ON public.customer_live_trip_projections (customer_user_id);

CREATE INDEX IF NOT EXISTS customer_live_trip_projections_eligible_idx
  ON public.customer_live_trip_projections (eligible)
  WHERE eligible = true AND terminal = false;

COMMENT ON TABLE public.customer_live_trip_projections IS
  'Presentation-only Live Trip Lock Screen projection. Never authoritative for dispatch/payment.';

COMMENT ON COLUMN public.customer_live_trip_projections.assignment_generation IS
  'Monotonic assignment generation — increments on rematch clear and replacement assign.';

COMMENT ON COLUMN public.customer_live_trip_projections.presentation_version IS
  'Monotonic presentation version for stale rejection across devices and delayed delivery.';

-- ActivityKit push tokens (iOS). Bound to authoritative active device.
CREATE TABLE IF NOT EXISTS public.customer_live_activity_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL,
  device_id text NOT NULL,
  trip_id uuid NULL REFERENCES public.trips(id) ON DELETE SET NULL,
  activity_id text NULL,
  push_token text NOT NULL,
  push_to_start_token text NULL,
  platform text NOT NULL DEFAULT 'ios',
  bundle_id text NOT NULL DEFAULT 'com.onecab.customer.app',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  invalidated_at timestamptz NULL,
  UNIQUE (customer_user_id, device_id, trip_id)
);

CREATE INDEX IF NOT EXISTS customer_live_activity_tokens_trip_alive_idx
  ON public.customer_live_activity_tokens (trip_id)
  WHERE invalidated_at IS NULL;

CREATE INDEX IF NOT EXISTS customer_live_activity_tokens_user_alive_idx
  ON public.customer_live_activity_tokens (customer_user_id)
  WHERE invalidated_at IS NULL;

COMMENT ON TABLE public.customer_live_activity_tokens IS
  'ActivityKit push tokens for server-driven Live Activity updates. Auth user + device scoped.';

ALTER TABLE public.customer_live_trip_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_live_activity_tokens ENABLE ROW LEVEL SECURITY;

-- Customers may read their own projection (optional client reconcile). Writes = service role only.
DROP POLICY IF EXISTS customer_live_trip_projections_select_own ON public.customer_live_trip_projections;
CREATE POLICY customer_live_trip_projections_select_own
  ON public.customer_live_trip_projections
  FOR SELECT
  TO authenticated
  USING (customer_user_id = auth.uid());

DROP POLICY IF EXISTS customer_live_activity_tokens_select_own ON public.customer_live_activity_tokens;
CREATE POLICY customer_live_activity_tokens_select_own
  ON public.customer_live_activity_tokens
  FOR SELECT
  TO authenticated
  USING (customer_user_id = auth.uid());
