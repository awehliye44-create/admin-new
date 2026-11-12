-- Phase 4: Just-in-Time confirmed scheduled activation columns + Admin config.
-- NOT applied to production until Phase 4 deploy is explicitly approved.
-- Does not change unclaimed Local/Long conversion timings.
-- Default: jit_auto_activate_enabled=false → ack-safe exclusive NRO arm only.

ALTER TABLE public.global_dispatch_settings
  ADD COLUMN IF NOT EXISTS jit_target_early_arrival_minutes integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS jit_local_safety_buffer_minutes integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS jit_long_safety_buffer_minutes integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS jit_long_distance_eta_threshold_minutes integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS jit_oscillation_tolerance_minutes integer NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS jit_planning_horizon_minutes integer NOT NULL DEFAULT 90,
  ADD COLUMN IF NOT EXISTS jit_max_early_pull_ahead_of_fixed_minutes integer NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS jit_auto_activate_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.global_dispatch_settings.jit_target_early_arrival_minutes IS
  'Phase 4 JIT: minutes before pickup the confirmed driver should arrive (default 5).';
COMMENT ON COLUMN public.global_dispatch_settings.jit_local_safety_buffer_minutes IS
  'Phase 4 JIT: safety buffer when driver→pickup ETA < long threshold (default 3).';
COMMENT ON COLUMN public.global_dispatch_settings.jit_long_safety_buffer_minutes IS
  'Phase 4 JIT: safety buffer when driver→pickup ETA ≥ long threshold (default 5).';
COMMENT ON COLUMN public.global_dispatch_settings.jit_long_distance_eta_threshold_minutes IS
  'Phase 4 JIT: driver→pickup ETA minutes at/above which long buffer applies (default 30).';
COMMENT ON COLUMN public.global_dispatch_settings.jit_oscillation_tolerance_minutes IS
  'Phase 4 JIT: ignore smaller deadline moves to avoid oscillation (default 2).';
COMMENT ON COLUMN public.global_dispatch_settings.jit_planning_horizon_minutes IS
  'Phase 4 JIT: only monitor ETA within this many minutes of pickup (default 90).';
COMMENT ON COLUMN public.global_dispatch_settings.jit_max_early_pull_ahead_of_fixed_minutes IS
  'Phase 4 JIT: clamp sticky deadline so it cannot be more than this many minutes earlier than fixed Local/Long activation (default 20).';
COMMENT ON COLUMN public.global_dispatch_settings.jit_auto_activate_enabled IS
  'Phase 4: when false (default), due deadline arms exclusive NRO acknowledgement. When true, may auto-activate to en_route. Phase 5 will supersede with 45s ack.';

UPDATE public.global_dispatch_settings
SET
  jit_target_early_arrival_minutes = COALESCE(jit_target_early_arrival_minutes, 5),
  jit_local_safety_buffer_minutes = COALESCE(jit_local_safety_buffer_minutes, 3),
  jit_long_safety_buffer_minutes = COALESCE(jit_long_safety_buffer_minutes, 5),
  jit_long_distance_eta_threshold_minutes = COALESCE(jit_long_distance_eta_threshold_minutes, 30),
  jit_oscillation_tolerance_minutes = COALESCE(jit_oscillation_tolerance_minutes, 2),
  jit_planning_horizon_minutes = COALESCE(jit_planning_horizon_minutes, 90),
  jit_max_early_pull_ahead_of_fixed_minutes = COALESCE(jit_max_early_pull_ahead_of_fixed_minutes, 20),
  jit_auto_activate_enabled = COALESCE(jit_auto_activate_enabled, false)
WHERE singleton = true;

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS scheduled_jit_activate_at timestamptz,
  ADD COLUMN IF NOT EXISTS scheduled_jit_eta_minutes numeric,
  ADD COLUMN IF NOT EXISTS scheduled_jit_eta_observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS scheduled_jit_distance_kind text,
  ADD COLUMN IF NOT EXISTS scheduled_jit_eta_source text,
  ADD COLUMN IF NOT EXISTS scheduled_jit_basis_scheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS scheduled_jit_activated_at timestamptz,
  ADD COLUMN IF NOT EXISTS scheduled_jit_activation_source text;

COMMENT ON COLUMN public.trips.scheduled_jit_activate_at IS
  'Phase 4 sticky JIT departure deadline (UTC) for confirmed-driver activation arm/activate.';
COMMENT ON COLUMN public.trips.scheduled_jit_basis_scheduled_at IS
  'Phase 4: scheduled_at used when sticky deadline was computed — invalidate on pickup reschedule.';
COMMENT ON COLUMN public.trips.scheduled_jit_activated_at IS
  'Phase 4 timestamp when confirmed scheduled trip auto-activated to en_route_to_pickup (only if auto-activate enabled).';

CREATE INDEX IF NOT EXISTS idx_trips_scheduled_jit_activate_due
  ON public.trips (scheduled_jit_activate_at)
  WHERE dispatch_mode = 'scheduled'
    AND confirmed_driver_id IS NOT NULL
    AND driver_id IS NULL
    AND scheduled_status IN ('driver_assigned', 'scheduled', 'scheduled_committed', 'awaiting_activation_accept');
