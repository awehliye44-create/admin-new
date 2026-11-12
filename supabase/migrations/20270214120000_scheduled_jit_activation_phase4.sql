-- Phase 4: Just-in-Time confirmed scheduled activation columns + Admin config.
-- NOT applied to production until Phase 4 deploy is explicitly approved.
-- Does not change unclaimed Local/Long conversion timings.
-- Default: jit_auto_activate_enabled=false → ack-safe exclusive NRO arm only.
-- Phase 4 Edge hard-locks auto_activate off; DB flag cannot enable no-ack en_route.

ALTER TABLE public.global_dispatch_settings
  ADD COLUMN IF NOT EXISTS jit_target_early_arrival_minutes integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS jit_local_safety_buffer_minutes integer NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS jit_long_safety_buffer_minutes integer NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS jit_long_distance_eta_threshold_minutes integer NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS jit_oscillation_tolerance_minutes integer NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS jit_planning_horizon_minutes integer NOT NULL DEFAULT 180,
  ADD COLUMN IF NOT EXISTS jit_max_early_pull_ahead_of_fixed_minutes integer NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS jit_eta_spike_confirm_samples integer NOT NULL DEFAULT 2,
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
  'Phase 4 JIT: base planning horizon minutes before pickup (default 180). Effective horizon expands with last-known ETA / long-distance lead so distant drivers are not concealed.';
COMMENT ON COLUMN public.global_dispatch_settings.jit_max_early_pull_ahead_of_fixed_minutes IS
  'DEPRECATED for deadline math: retained for column compat. Fixed Local/Long is fallback only when JIT ETA unavailable — never clamps/delays a genuine earlier JIT deadline. Spike damping uses eta validation samples instead.';
COMMENT ON COLUMN public.global_dispatch_settings.jit_eta_spike_confirm_samples IS
  'Phase 4 JIT: consecutive elevated-ETA samples required before sticky deadline pulls earlier past a spike (default 2).';
COMMENT ON COLUMN public.global_dispatch_settings.jit_auto_activate_enabled IS
  'Phase 4: MUST remain false. Edge resolveJitExecutionMode always ack_nro — DB cannot enable no-ack en_route. Phase 5 will own 45s acknowledgement before any en_route stamp.';

UPDATE public.global_dispatch_settings
SET
  jit_target_early_arrival_minutes = COALESCE(jit_target_early_arrival_minutes, 5),
  jit_local_safety_buffer_minutes = COALESCE(jit_local_safety_buffer_minutes, 3),
  jit_long_safety_buffer_minutes = COALESCE(jit_long_safety_buffer_minutes, 5),
  jit_long_distance_eta_threshold_minutes = COALESCE(jit_long_distance_eta_threshold_minutes, 30),
  jit_oscillation_tolerance_minutes = COALESCE(jit_oscillation_tolerance_minutes, 2),
  jit_planning_horizon_minutes = GREATEST(COALESCE(jit_planning_horizon_minutes, 180), 180),
  jit_max_early_pull_ahead_of_fixed_minutes = COALESCE(jit_max_early_pull_ahead_of_fixed_minutes, 20),
  jit_eta_spike_confirm_samples = COALESCE(jit_eta_spike_confirm_samples, 2),
  jit_auto_activate_enabled = false
WHERE singleton = true;

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS scheduled_jit_activate_at timestamptz,
  ADD COLUMN IF NOT EXISTS scheduled_jit_eta_minutes numeric,
  ADD COLUMN IF NOT EXISTS scheduled_jit_eta_observed_at timestamptz,
  ADD COLUMN IF NOT EXISTS scheduled_jit_distance_kind text,
  ADD COLUMN IF NOT EXISTS scheduled_jit_eta_source text,
  ADD COLUMN IF NOT EXISTS scheduled_jit_basis_scheduled_at timestamptz,
  ADD COLUMN IF NOT EXISTS scheduled_jit_activated_at timestamptz,
  ADD COLUMN IF NOT EXISTS scheduled_jit_activation_source text,
  ADD COLUMN IF NOT EXISTS scheduled_jit_eta_spike_samples integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.trips.scheduled_jit_activate_at IS
  'Phase 4 sticky JIT departure deadline (UTC) for confirmed-driver activation arm (ack NRO).';
COMMENT ON COLUMN public.trips.scheduled_jit_basis_scheduled_at IS
  'Phase 4: scheduled_at used when sticky deadline was computed — invalidate on pickup reschedule.';
COMMENT ON COLUMN public.trips.scheduled_jit_activated_at IS
  'Reserved: timestamp when confirmed scheduled trip activated to en_route. Phase 4 never stamps without acknowledgement.';
COMMENT ON COLUMN public.trips.scheduled_jit_eta_spike_samples IS
  'Phase 4: consecutive elevated ETA samples awaiting spike confirmation before pull-earlier.';

CREATE INDEX IF NOT EXISTS idx_trips_scheduled_jit_activate_due
  ON public.trips (scheduled_jit_activate_at)
  WHERE dispatch_mode = 'scheduled'
    AND confirmed_driver_id IS NOT NULL
    AND driver_id IS NULL
    AND scheduled_status IN ('driver_assigned', 'scheduled', 'scheduled_committed', 'awaiting_activation_accept');
